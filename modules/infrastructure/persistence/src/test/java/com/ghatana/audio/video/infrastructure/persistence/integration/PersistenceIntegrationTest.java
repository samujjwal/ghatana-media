package com.ghatana.audio.video.infrastructure.persistence.integration;

import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import com.ghatana.audio.video.infrastructure.persistence.repository.JpaAudioFileRepository;
import com.ghatana.audio.video.infrastructure.persistence.repository.JpaTranscriptionRepository;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.testing.activej.EventloopTestBase;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import jakarta.persistence.Persistence;
import jakarta.persistence.RollbackException;
import org.hibernate.Session;
import org.junit.jupiter.api.*;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import java.sql.DriverManager;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * @doc.type class
 * @doc.purpose Integration tests for persistence layer with PostgreSQL Testcontainer
 * @doc.layer test
 * @doc.pattern Integration Test
 */
@DisplayName("Persistence Integration Tests")
@Testcontainers
@TestInstance(TestInstance.Lifecycle.PER_CLASS) 
class PersistenceIntegrationTest extends EventloopTestBase {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>( 
        DockerImageName.parse("postgres:16-alpine")
    )
    .withDatabaseName("audio_video_test")
    .withUsername("test")
    .withPassword("test");

    private EntityManagerFactory emf;
    private EntityManager entityManager;
    private JpaAudioFileRepository audioFileRepository;
    private JpaTranscriptionRepository transcriptionRepository;

    @BeforeAll
    void setUpClass() { 
        try (var connection = DriverManager.getConnection( 
            postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword()); 
             var statement = connection.createStatement()) { 
            statement.execute("CREATE SCHEMA IF NOT EXISTS audio_video");
        } catch (Exception e) { 
            throw new RuntimeException("Failed to create test schema audio_video", e); 
        }

        // Configure persistence unit with Testcontainer database
        Map<String, String> properties = new HashMap<>(); 
        properties.put("jakarta.persistence.jdbc.url", postgres.getJdbcUrl()); 
        properties.put("jakarta.persistence.jdbc.user", postgres.getUsername()); 
        properties.put("jakarta.persistence.jdbc.password", postgres.getPassword()); 
        properties.put("jakarta.persistence.jdbc.driver", "org.postgresql.Driver"); 
        properties.put("hibernate.dialect", "org.hibernate.dialect.PostgreSQLDialect"); 
        properties.put("hibernate.hbm2ddl.auto", "create-drop"); 
        properties.put("hibernate.default_schema", "audio_video"); 
        properties.put("hibernate.show_sql", "true"); 

        emf = Persistence.createEntityManagerFactory("audio-video-test", properties); 
    }

    @BeforeEach
    void setUp() { 
        entityManager = emf.createEntityManager(); 
        audioFileRepository = new JpaAudioFileRepository(entityManager); 
        transcriptionRepository = new JpaTranscriptionRepository(entityManager); 
    }

    @AfterEach
    void tearDown() { 
        if (entityManager != null && entityManager.isOpen()) { 
            entityManager.close(); 
        }
    }

    @AfterAll
    void tearDownClass() { 
        if (emf != null && emf.isOpen()) { 
            emf.close(); 
        }
    }

    @Test
    @DisplayName("combined audio/transcription save preserves tenant ownership and rolls back on conflict")
    void postgresCombinedSaveRejectsCrossTenantTranscriptionAndRollsBackAudio() {
        String owner = "owner-" + UUID.randomUUID();
        String attacker = "attacker-" + UUID.randomUUID();
        AudioFileEntity originalAudio = createAudioFile(owner, "owner.wav");
        audioFileRepository.save(owner, originalAudio);
        TranscriptionEntity original = new TranscriptionEntity(UUID.randomUUID(), owner,
                originalAudio.getId(), UUID.randomUUID(), "owner text", "en");
        transcriptionRepository.save(owner, original);
        entityManager.clear();

        AudioFileEntity newAudio = createAudioFile(attacker, "new.wav");
        UUID priorAudioId = UUID.randomUUID();
        TranscriptionEntity forged = new TranscriptionEntity(original.getId(), attacker,
                priorAudioId, UUID.randomUUID(), "forged text", "en");
        var executor = java.util.concurrent.Executors.newSingleThreadExecutor();
        var service = new AudioFileService(audioFileRepository, eventloop(), executor);
        try {
            assertThatThrownBy(() -> runPromise(() -> service.saveWithTranscription(attacker, newAudio, forged)))
                    .hasRootCauseInstanceOf(IllegalArgumentException.class)
                    .hasRootCauseMessage("Transcription does not belong to save tenant");
            assertThat(forged.getAudioFileId()).isEqualTo(priorAudioId);
            entityManager.clear();
            assertThat(audioFileRepository.findById(attacker, newAudio.getId())).isEmpty();
            assertThat(transcriptionRepository.findById(owner, original.getId()).orElseThrow().getText())
                    .isEqualTo("owner text");

        } finally {
            service.close();
            executor.shutdownNow();
        }
    }

    @Test
    @DisplayName("combined audio/transcription save commits both records for an authorized tenant")
    void postgresCombinedSavePersistsSameTenantRecords() {
        String owner = "owner-" + UUID.randomUUID();
        var executor = java.util.concurrent.Executors.newSingleThreadExecutor();
        var service = new AudioFileService(audioFileRepository, eventloop(), executor);
        try {
            AudioFileEntity admittedAudio = createAudioFile(owner, "admitted.wav");
            TranscriptionEntity admitted = new TranscriptionEntity(UUID.randomUUID(), owner,
                    admittedAudio.getId(), UUID.randomUUID(), "admitted text", "en");
            runPromise(() -> service.saveWithTranscription(owner, admittedAudio, admitted));
            entityManager.clear();
            assertThat(audioFileRepository.findById(owner, admittedAudio.getId())).isPresent();
            assertThat(transcriptionRepository.findById(owner, admitted.getId()).orElseThrow().getAudioFileId())
                    .isEqualTo(admittedAudio.getId());
        } finally {
            service.close();
            executor.shutdownNow();
        }
    }

    @Test
    @DisplayName("combined save rolls back audio when transcription persistence fails at the database")
    void postgresCombinedSaveRollsBackAudioWhenTranscriptionConstraintFails() {
        String tenantId = "constraint-rollback-" + UUID.randomUUID();
        AudioFileEntity audio = createAudioFile(tenantId, "constraint-rollback.wav");
        UUID originalAudioId = UUID.randomUUID();
        TranscriptionEntity invalidTranscription = new TranscriptionEntity(
                UUID.randomUUID(), tenantId, originalAudioId, UUID.randomUUID(), "valid text", "english-too-long");
        var executor = java.util.concurrent.Executors.newSingleThreadExecutor();
        var service = new AudioFileService(audioFileRepository, eventloop(), executor);
        try {
            assertThatThrownBy(() -> runPromise(() ->
                    service.saveWithTranscription(tenantId, audio, invalidTranscription)))
                    .isInstanceOf(RuntimeException.class)
                    .satisfies(failure -> {
                        boolean postgresVarcharViolation = false;
                        StringBuilder causeMessages = new StringBuilder();
                        for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
                            if (causeMessages.length() > 0) causeMessages.append(" -> ");
                            causeMessages.append(cause.getClass().getSimpleName())
                                    .append(": ").append(cause.getMessage());
                            if (cause.getMessage() != null
                                    && cause.getMessage().contains("value too long for type character varying")) {
                                postgresVarcharViolation = true;
                                break;
                            }
                        }
                        assertThat(postgresVarcharViolation)
                                .as("the second row must fail at PostgreSQL's language length constraint; cause chain: %s",
                                        causeMessages)
                                .isTrue();
                    });

            assertThat(invalidTranscription.getAudioFileId())
                    .as("failed combined save restores the caller's source-audio identity")
                    .isEqualTo(originalAudioId);
            entityManager.clear();
            assertThat(audioFileRepository.findById(tenantId, audio.getId()))
                    .as("audio row is rolled back when the paired transcription violates its database constraint")
                    .isEmpty();
            assertThat(transcriptionRepository.findById(tenantId, invalidTranscription.getId()))
                    .as("invalid transcription row is not committed")
                    .isEmpty();
        } finally {
            service.close();
            executor.shutdownNow();
        }
    }

    @Test
    @DisplayName("PostgreSQL records remain readable after closing and reopening the persistence factory")
    void postgresReadbackSurvivesEntityManagerFactoryRestart() throws Throwable {
        String databaseName = "media_restart_" + UUID.randomUUID().toString().replace("-", "");
        String jdbcUrl = postgres.getJdbcUrl().substring(0, postgres.getJdbcUrl().lastIndexOf('/') + 1)
                + databaseName;
        EntityManagerFactory writingFactory = null;
        EntityManagerFactory reopenedFactory = null;
        EntityManager writingManager = null;
        EntityManager reopenedManager = null;
        Throwable primaryFailure = null;

        try {
            try (var connection = DriverManager.getConnection(
                    postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                 var statement = connection.createStatement()) {
                statement.execute("CREATE DATABASE \"" + databaseName + "\"");
            }
            try (var connection = DriverManager.getConnection(jdbcUrl, postgres.getUsername(), postgres.getPassword());
                 var statement = connection.createStatement()) {
                statement.execute("CREATE SCHEMA audio_video");
            }

            Map<String, Object> properties = postgresPersistenceProperties(jdbcUrl, "create");
            writingFactory = Persistence.createEntityManagerFactory("audio-video-test", properties);
            writingManager = writingFactory.createEntityManager();
            String tenantId = "restart-tenant-" + UUID.randomUUID();
            AudioFileEntity audio = createAudioFile(tenantId, "restart.wav");
            TranscriptionEntity transcript = new TranscriptionEntity(
                    UUID.randomUUID(), tenantId, audio.getId(), UUID.randomUUID(), "restart transcript", "en");
            new JpaAudioFileRepository(writingManager).save(tenantId, audio);
            new JpaTranscriptionRepository(writingManager).save(tenantId, transcript);

            writingManager.close();
            writingManager = null;
            writingFactory.close();
            writingFactory = null;

            reopenedFactory = Persistence.createEntityManagerFactory(
                    "audio-video-test", postgresPersistenceProperties(jdbcUrl, "validate"));
            reopenedManager = reopenedFactory.createEntityManager();
            assertThat(new JpaAudioFileRepository(reopenedManager).findById(tenantId, audio.getId()))
                    .get()
                    .satisfies(persisted -> {
                        assertThat(persisted.getFileName()).isEqualTo("restart.wav");
                        assertThat(persisted.getTenantId()).isEqualTo(tenantId);
                    });
            assertThat(new JpaTranscriptionRepository(reopenedManager).findById(tenantId, transcript.getId()))
                    .get()
                    .satisfies(persisted -> {
                        assertThat(persisted.getText()).isEqualTo("restart transcript");
                        assertThat(persisted.getAudioFileId()).isEqualTo(audio.getId());
                    });
        } catch (Throwable failure) {
            primaryFailure = failure;
            throw failure;
        } finally {
            Throwable cleanupFailure = null;
            cleanupFailure = closeTestEntityManager(reopenedManager, cleanupFailure);
            cleanupFailure = closeTestFactory(reopenedFactory, cleanupFailure);
            cleanupFailure = closeTestEntityManager(writingManager, cleanupFailure);
            cleanupFailure = closeTestFactory(writingFactory, cleanupFailure);
            try (var connection = DriverManager.getConnection(
                    postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                 var statement = connection.createStatement()) {
                statement.execute("DROP DATABASE IF EXISTS \"" + databaseName + "\" WITH (FORCE)");
            } catch (Throwable dropFailure) {
                cleanupFailure = appendCleanupFailure(cleanupFailure, dropFailure);
            }
            if (cleanupFailure != null) {
                if (primaryFailure != null) {
                    primaryFailure.addSuppressed(cleanupFailure);
                } else {
                    throw cleanupFailure;
                }
            }
        }
    }

    @Test
    @DisplayName("PostgreSQL hard deletion remains absent after closing and reopening the persistence factory")
    void postgresHardDeleteRemainsAbsentAfterEntityManagerFactoryRestart() throws Throwable {
        String databaseName = "media_delete_restart_" + UUID.randomUUID().toString().replace("-", "");
        String jdbcUrl = postgres.getJdbcUrl().substring(0, postgres.getJdbcUrl().lastIndexOf('/') + 1)
                + databaseName;
        EntityManagerFactory writingFactory = null;
        EntityManagerFactory reopenedFactory = null;
        EntityManager writingManager = null;
        EntityManager reopenedManager = null;
        Throwable primaryFailure = null;

        try {
            try (var connection = DriverManager.getConnection(
                    postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                 var statement = connection.createStatement()) {
                statement.execute("CREATE DATABASE \"" + databaseName + "\"");
            }
            try (var connection = DriverManager.getConnection(jdbcUrl, postgres.getUsername(), postgres.getPassword());
                 var statement = connection.createStatement()) {
                statement.execute("CREATE SCHEMA audio_video");
            }

            writingFactory = Persistence.createEntityManagerFactory(
                    "audio-video-test", postgresPersistenceProperties(jdbcUrl, "create"));
            writingManager = writingFactory.createEntityManager();
            String tenantId = "delete-restart-tenant-" + UUID.randomUUID();
            AudioFileEntity audio = createAudioFile(tenantId, "deleted.wav");
            JpaAudioFileRepository writingRepository = new JpaAudioFileRepository(writingManager);
            writingRepository.save(tenantId, audio);
            assertThat(writingRepository.hardDelete(tenantId, audio.getId())).isTrue();

            writingManager.close();
            writingManager = null;
            writingFactory.close();
            writingFactory = null;

            reopenedFactory = Persistence.createEntityManagerFactory(
                    "audio-video-test", postgresPersistenceProperties(jdbcUrl, "validate"));
            reopenedManager = reopenedFactory.createEntityManager();
            JpaAudioFileRepository reopenedRepository = new JpaAudioFileRepository(reopenedManager);
            assertThat(reopenedRepository.findById(tenantId, audio.getId()))
                    .as("hard-deleted audio remains absent from a fresh persistence factory")
                    .isEmpty();
            assertThat(reopenedManager.createNativeQuery(
                            "SELECT COUNT(*) FROM audio_video.audio_files WHERE id = :id")
                    .setParameter("id", audio.getId())
                    .getSingleResult())
                    .as("the hard-deleted database row is absent after factory restart")
                    .isEqualTo(0L);
        } catch (Throwable failure) {
            primaryFailure = failure;
            throw failure;
        } finally {
            Throwable cleanupFailure = null;
            cleanupFailure = closeTestEntityManager(reopenedManager, cleanupFailure);
            cleanupFailure = closeTestFactory(reopenedFactory, cleanupFailure);
            cleanupFailure = closeTestEntityManager(writingManager, cleanupFailure);
            cleanupFailure = closeTestFactory(writingFactory, cleanupFailure);
            try (var connection = DriverManager.getConnection(
                    postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                 var statement = connection.createStatement()) {
                statement.execute("DROP DATABASE IF EXISTS \"" + databaseName + "\" WITH (FORCE)");
            } catch (Throwable dropFailure) {
                cleanupFailure = appendCleanupFailure(cleanupFailure, dropFailure);
            }
            if (cleanupFailure != null) {
                if (primaryFailure != null) {
                    primaryFailure.addSuppressed(cleanupFailure);
                } else {
                    throw cleanupFailure;
                }
            }
        }
    }

    @Test
    @DisplayName("PostgreSQL restart readback preserves tenant-scoped audio and transcription visibility")
    void postgresRestartReadbackRemainsTenantScoped() throws Throwable {
        String databaseName = "media_tenant_restart_" + UUID.randomUUID().toString().replace("-", "");
        String jdbcUrl = postgres.getJdbcUrl().substring(0, postgres.getJdbcUrl().lastIndexOf('/') + 1)
                + databaseName;
        String ownerTenant = "restart-owner-" + UUID.randomUUID();
        String otherTenant = "restart-other-" + UUID.randomUUID();
        AudioFileEntity audio = createAudioFile(ownerTenant, "tenant-restart.wav");
        TranscriptionEntity transcription = new TranscriptionEntity(UUID.randomUUID(), ownerTenant,
                audio.getId(), UUID.randomUUID(), "tenant restart transcript", "en");
        EntityManagerFactory writingFactory = null;
        EntityManager writingManager = null;
        EntityManagerFactory reopenedFactory = null;
        EntityManager reopenedManager = null;
        Throwable primaryFailure = null;

        try {
            try (var connection = DriverManager.getConnection(
                    postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                 var statement = connection.createStatement()) {
                statement.execute("CREATE DATABASE \"" + databaseName + "\"");
            }
            try (var connection = DriverManager.getConnection(jdbcUrl, postgres.getUsername(), postgres.getPassword());
                 var statement = connection.createStatement()) {
                statement.execute("CREATE SCHEMA audio_video");
            }

            writingFactory = Persistence.createEntityManagerFactory(
                    "audio-video-test", postgresPersistenceProperties(jdbcUrl, "create"));
            writingManager = writingFactory.createEntityManager();
            new JpaAudioFileRepository(writingManager).save(ownerTenant, audio);
            new JpaTranscriptionRepository(writingManager).save(ownerTenant, transcription);
            writingManager.close();
            writingManager = null;
            writingFactory.close();
            writingFactory = null;

            reopenedFactory = Persistence.createEntityManagerFactory(
                    "audio-video-test", postgresPersistenceProperties(jdbcUrl, "validate"));
            reopenedManager = reopenedFactory.createEntityManager();
            JpaAudioFileRepository audioRepository = new JpaAudioFileRepository(reopenedManager);
            JpaTranscriptionRepository transcriptionRepository = new JpaTranscriptionRepository(reopenedManager);

            assertThat(audioRepository.findById(ownerTenant, audio.getId()))
                    .get()
                    .satisfies(persisted -> {
                        assertThat(persisted.getTenantId()).isEqualTo(ownerTenant);
                        assertThat(persisted.getFileName()).isEqualTo("tenant-restart.wav");
                    });
            assertThat(transcriptionRepository.findById(ownerTenant, transcription.getId()))
                    .get()
                    .satisfies(persisted -> {
                        assertThat(persisted.getTenantId()).isEqualTo(ownerTenant);
                        assertThat(persisted.getAudioFileId()).isEqualTo(audio.getId());
                        assertThat(persisted.getText()).isEqualTo("tenant restart transcript");
                    });
            assertThat(audioRepository.findById(otherTenant, audio.getId())).isEmpty();
            assertThat(transcriptionRepository.findById(otherTenant, transcription.getId())).isEmpty();
        } catch (Throwable failure) {
            primaryFailure = failure;
            throw failure;
        } finally {
            Throwable cleanupFailure = null;
            cleanupFailure = closeTestEntityManager(reopenedManager, cleanupFailure);
            cleanupFailure = closeTestFactory(reopenedFactory, cleanupFailure);
            cleanupFailure = closeTestEntityManager(writingManager, cleanupFailure);
            cleanupFailure = closeTestFactory(writingFactory, cleanupFailure);
            try (var connection = DriverManager.getConnection(
                    postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                 var statement = connection.createStatement()) {
                statement.execute("DROP DATABASE IF EXISTS \"" + databaseName + "\" WITH (FORCE)");
            } catch (Throwable dropFailure) {
                cleanupFailure = appendCleanupFailure(cleanupFailure, dropFailure);
            }
            if (cleanupFailure != null) {
                if (primaryFailure != null) primaryFailure.addSuppressed(cleanupFailure);
                else throw cleanupFailure;
            }
        }
    }

    @Test
    @DisplayName("PostgreSQL rolls back an uncommitted row when its backend session is terminated")
    void postgresBackendTerminationDoesNotCommitFlushedAudio() throws Throwable {
        String tenantId = "crash-tenant-" + UUID.randomUUID();
        AudioFileEntity interruptedAudio = createAudioFile(tenantId, "interrupted.wav");
        EntityManager interruptedManager = emf.createEntityManager();
        Throwable primaryFailure = null;
        try {
            interruptedManager.getTransaction().begin();
            interruptedManager.persist(interruptedAudio);
            interruptedManager.flush();

            int backendPid = interruptedManager.unwrap(Session.class).doReturningWork(connection -> {
                try (var statement = connection.createStatement();
                     var result = statement.executeQuery("SELECT pg_backend_pid()")) {
                    result.next();
                    return result.getInt(1);
                }
            });
            try (var connection = DriverManager.getConnection(
                    postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                 var statement = connection.prepareStatement("SELECT pg_terminate_backend(?)")) {
                statement.setInt(1, backendPid);
                try (var result = statement.executeQuery()) {
                    assertThat(result.next()).isTrue();
                    assertThat(result.getBoolean(1)).isTrue();
                }
            }

            long exitDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            boolean backendExited = false;
            while (!backendExited && System.nanoTime() < exitDeadline) {
                try (var connection = DriverManager.getConnection(
                        postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                     var statement = connection.prepareStatement(
                             "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = ?)")) {
                    statement.setInt(1, backendPid);
                    try (var result = statement.executeQuery()) {
                        result.next();
                        backendExited = !result.getBoolean(1);
                    }
                }
                if (!backendExited) {
                    Thread.sleep(25L);
                }
            }
            assertThat(backendExited)
                    .as("PostgreSQL backend %s exits after pg_terminate_backend", backendPid)
                    .isTrue();

            assertThatThrownBy(() -> interruptedManager.getTransaction().commit())
                    .isInstanceOf(RollbackException.class);
        } catch (Throwable failure) {
            primaryFailure = failure;
            throw failure;
        } finally {
            Throwable cleanupFailure = null;
            if (interruptedManager.isOpen()) {
                if (interruptedManager.getTransaction().isActive()) {
                    try {
                        interruptedManager.getTransaction().rollback();
                    } catch (Throwable rollbackFailure) {
                        cleanupFailure = appendCleanupFailure(cleanupFailure, rollbackFailure);
                    }
                }
                cleanupFailure = closeTestEntityManager(interruptedManager, cleanupFailure);
            }
            if (cleanupFailure != null) {
                if (primaryFailure != null) {
                    primaryFailure.addSuppressed(cleanupFailure);
                } else {
                    throw cleanupFailure;
                }
            }
        }

        entityManager.clear();
        try (var connection = DriverManager.getConnection(
                postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
             var statement = connection.prepareStatement(
                     "SELECT COUNT(*) FROM audio_video.audio_files WHERE id = ?")) {
            statement.setObject(1, interruptedAudio.getId());
            try (var result = statement.executeQuery()) {
                result.next();
                assertThat(result.getLong(1)).isZero();
            }
        }
        assertThat(audioFileRepository.findById(tenantId, interruptedAudio.getId())).isEmpty();
    }

    @Test
    @DisplayName("PostgreSQL backend termination rolls back flushed audio and transcription together")
    void postgresBackendTerminationRollsBackCombinedAudioAndTranscription() throws Throwable {
        String tenantId = "combined-crash-tenant-" + UUID.randomUUID();
        AudioFileEntity interruptedAudio = createAudioFile(tenantId, "combined-interrupted.wav");
        TranscriptionEntity interruptedTranscription = new TranscriptionEntity(
                UUID.randomUUID(), tenantId, interruptedAudio.getId(), UUID.randomUUID(),
                "must not commit", "en");
        EntityManager interruptedManager = emf.createEntityManager();
        Throwable primaryFailure = null;
        try {
            interruptedManager.getTransaction().begin();
            interruptedManager.persist(interruptedAudio);
            interruptedManager.persist(interruptedTranscription);
            interruptedManager.flush();

            int backendPid = interruptedManager.unwrap(Session.class).doReturningWork(connection -> {
                try (var statement = connection.createStatement();
                     var result = statement.executeQuery("SELECT pg_backend_pid()")) {
                    result.next();
                    return result.getInt(1);
                }
            });
            try (var connection = DriverManager.getConnection(
                    postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                 var statement = connection.prepareStatement("SELECT pg_terminate_backend(?)")) {
                statement.setInt(1, backendPid);
                try (var result = statement.executeQuery()) {
                    assertThat(result.next()).isTrue();
                    assertThat(result.getBoolean(1)).isTrue();
                }
            }

            long exitDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            boolean backendExited = false;
            while (!backendExited && System.nanoTime() < exitDeadline) {
                try (var connection = DriverManager.getConnection(
                        postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                     var statement = connection.prepareStatement(
                             "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = ?)")) {
                    statement.setInt(1, backendPid);
                    try (var result = statement.executeQuery()) {
                        result.next();
                        backendExited = !result.getBoolean(1);
                    }
                }
                if (!backendExited) {
                    Thread.sleep(25L);
                }
            }
            assertThat(backendExited)
                    .as("PostgreSQL backend %s exits after pg_terminate_backend", backendPid)
                    .isTrue();

            assertThatThrownBy(() -> interruptedManager.getTransaction().commit())
                    .isInstanceOf(RollbackException.class);
        } catch (Throwable failure) {
            primaryFailure = failure;
            throw failure;
        } finally {
            Throwable cleanupFailure = null;
            if (interruptedManager.isOpen()) {
                if (interruptedManager.getTransaction().isActive()) {
                    try {
                        interruptedManager.getTransaction().rollback();
                    } catch (Throwable rollbackFailure) {
                        cleanupFailure = appendCleanupFailure(cleanupFailure, rollbackFailure);
                    }
                }
                cleanupFailure = closeTestEntityManager(interruptedManager, cleanupFailure);
            }
            if (cleanupFailure != null) {
                if (primaryFailure != null) {
                    primaryFailure.addSuppressed(cleanupFailure);
                } else {
                    throw cleanupFailure;
                }
            }
        }

        entityManager.clear();
        try (var connection = DriverManager.getConnection(
                postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())) {
            try (var statement = connection.prepareStatement(
                    "SELECT COUNT(*) FROM audio_video.audio_files WHERE id = ?")) {
                statement.setObject(1, interruptedAudio.getId());
                try (var result = statement.executeQuery()) {
                    result.next();
                    assertThat(result.getLong(1)).as("audio row is absent after transaction rollback").isZero();
                }
            }
            try (var statement = connection.prepareStatement(
                    "SELECT COUNT(*) FROM audio_video.transcriptions WHERE id = ?")) {
                statement.setObject(1, interruptedTranscription.getId());
                try (var result = statement.executeQuery()) {
                    result.next();
                    assertThat(result.getLong(1))
                            .as("transcription row is absent after transaction rollback")
                            .isZero();
                }
            }
        }
        assertThat(audioFileRepository.findById(tenantId, interruptedAudio.getId())).isEmpty();
        assertThat(transcriptionRepository.findById(tenantId, interruptedTranscription.getId())).isEmpty();
    }

    private static Throwable closeTestEntityManager(EntityManager manager, Throwable previousFailure) {
        try {
            if (manager != null && manager.isOpen()) manager.close();
            return previousFailure;
        } catch (Throwable closeFailure) {
            return appendCleanupFailure(previousFailure, closeFailure);
        }
    }

    private static Throwable closeTestFactory(EntityManagerFactory factory, Throwable previousFailure) {
        try {
            if (factory != null && factory.isOpen()) factory.close();
            return previousFailure;
        } catch (Throwable closeFailure) {
            return appendCleanupFailure(previousFailure, closeFailure);
        }
    }

    private static Throwable appendCleanupFailure(Throwable previousFailure, Throwable nextFailure) {
        if (previousFailure == null) return nextFailure;
        previousFailure.addSuppressed(nextFailure);
        return previousFailure;
    }

    private Map<String, Object> postgresPersistenceProperties(String jdbcUrl, String schemaGeneration) {
        Map<String, Object> properties = new HashMap<>();
        properties.put("jakarta.persistence.jdbc.url", jdbcUrl);
        properties.put("jakarta.persistence.jdbc.user", postgres.getUsername());
        properties.put("jakarta.persistence.jdbc.password", postgres.getPassword());
        properties.put("jakarta.persistence.jdbc.driver", "org.postgresql.Driver");
        properties.put("hibernate.dialect", "org.hibernate.dialect.PostgreSQLDialect");
        properties.put("hibernate.hbm2ddl.auto", schemaGeneration);
        properties.put("hibernate.default_schema", "audio_video");
        properties.put("hibernate.show_sql", "false");
        return properties;
    }

    @Test
    @DisplayName("PostgreSQL rejects cross-tenant audio and transcription ID reuse")
    void postgresRejectsCrossTenantIdReuse() {
        String owner = "owner-" + UUID.randomUUID();
        String attacker = "attacker-" + UUID.randomUUID();
        AudioFileEntity audio = createAudioFile(owner, "original.wav");
        audioFileRepository.save(owner, audio);
        TranscriptionEntity transcript = new TranscriptionEntity(
                UUID.randomUUID(), owner, audio.getId(), UUID.randomUUID(), "original text", "en");
        transcriptionRepository.save(owner, transcript);
        entityManager.clear();

        AudioFileEntity forgedAudio = new AudioFileEntity(audio.getId(), attacker, audio.getUserId(),
                "overwritten.wav", "/forged.wav", "wav");
        TranscriptionEntity forgedTranscript = new TranscriptionEntity(transcript.getId(), attacker,
                audio.getId(), UUID.randomUUID(), "overwritten text", "en");
        assertThatThrownBy(() -> audioFileRepository.save(attacker, forgedAudio))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> transcriptionRepository.save(attacker, forgedTranscript))
                .isInstanceOf(IllegalArgumentException.class);
        entityManager.clear();
        assertThat(audioFileRepository.findById(owner, audio.getId()).orElseThrow().getFileName())
                .isEqualTo("original.wav");
        assertThat(transcriptionRepository.findById(owner, transcript.getId()).orElseThrow().getText())
                .isEqualTo("original text");
        assertThat(audioFileRepository.findById(attacker, audio.getId())).isEmpty();
        assertThat(transcriptionRepository.findById(attacker, transcript.getId())).isEmpty();

        // An already managed entity must not auto-flush an altered tenant before
        // the repository reads and locks the persisted owner.
        entityManager.getTransaction().begin();
        AudioFileEntity managed = audioFileRepository.findById(owner, audio.getId()).orElseThrow();
        managed.setTenantId(attacker);
        managed.setFileName("managed-overwrite.wav");
        assertThatThrownBy(() -> audioFileRepository.save(attacker, managed))
                .isInstanceOf(IllegalArgumentException.class);
        entityManager.getTransaction().commit();
        entityManager.clear();
        assertThat(audioFileRepository.findById(owner, audio.getId()).orElseThrow().getFileName())
                .isEqualTo("original.wav");
        assertThat(audioFileRepository.findById(attacker, audio.getId())).isEmpty();
    }

    @Test
    @DisplayName("PostgreSQL rejects rebinding a persisted audio file to another principal")
    void postgresRejectsAudioFilePrincipalRebinding() {
        String tenantId = "tenant-principal-" + UUID.randomUUID();
        AudioFileEntity original = createAudioFile(tenantId, "principal-bound.wav");
        UUID originalUserId = original.getUserId();
        audioFileRepository.save(tenantId, original);
        entityManager.clear();

        AudioFileEntity forged = audioFileRepository.findById(tenantId, original.getId()).orElseThrow();
        forged.setUserId(UUID.randomUUID());
        forged.setFileName("rebound.wav");
        assertThatThrownBy(() -> audioFileRepository.save(tenantId, forged))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("principal ownership cannot be changed");

        entityManager.clear();
        assertThat(audioFileRepository.findById(tenantId, original.getId())).get()
                .satisfies(persisted -> {
                    assertThat(persisted.getUserId()).isEqualTo(originalUserId);
                    assertThat(persisted.getFileName()).isEqualTo("principal-bound.wav");
                });
    }

    @Test
    @DisplayName("PostgreSQL rejects rebinding a persisted transcription to another principal")
    void postgresRejectsTranscriptionPrincipalRebinding() {
        String tenantId = "tenant-principal-" + UUID.randomUUID();
        TranscriptionEntity original = createTranscription(tenantId, "principal-bound transcript");
        UUID originalUserId = original.getUserId();
        UUID originalAudioFileId = original.getAudioFileId();
        transcriptionRepository.save(tenantId, original);
        entityManager.clear();

        TranscriptionEntity forged = transcriptionRepository.findById(tenantId, original.getId()).orElseThrow();
        forged.setUserId(UUID.randomUUID());
        forged.setText("rebound transcript");
        assertThatThrownBy(() -> transcriptionRepository.save(tenantId, forged))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("principal and source audio ownership cannot be changed");

        entityManager.clear();
        assertThat(transcriptionRepository.findById(tenantId, original.getId())).get()
                .satisfies(persisted -> {
                    assertThat(persisted.getUserId()).isEqualTo(originalUserId);
                    assertThat(persisted.getAudioFileId()).isEqualTo(originalAudioFileId);
                    assertThat(persisted.getText()).isEqualTo("principal-bound transcript");
                });
    }

    @Test
    @DisplayName("PostgreSQL rejects rebinding a persisted transcription to another source audio ID")
    void postgresRejectsTranscriptionSourceAudioRebinding() {
        String tenantId = "tenant-source-" + UUID.randomUUID();
        TranscriptionEntity original = createTranscription(tenantId, "source-bound transcript");
        UUID originalUserId = original.getUserId();
        UUID originalAudioFileId = original.getAudioFileId();
        transcriptionRepository.save(tenantId, original);
        entityManager.clear();

        TranscriptionEntity forged = transcriptionRepository.findById(tenantId, original.getId()).orElseThrow();
        forged.setAudioFileId(UUID.randomUUID());
        forged.setText("transcript for another source");
        assertThatThrownBy(() -> transcriptionRepository.save(tenantId, forged))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("principal and source audio ownership cannot be changed");

        entityManager.clear();
        assertThat(transcriptionRepository.findById(tenantId, original.getId())).get()
                .satisfies(persisted -> {
                    assertThat(persisted.getUserId()).isEqualTo(originalUserId);
                    assertThat(persisted.getAudioFileId()).isEqualTo(originalAudioFileId);
                    assertThat(persisted.getText()).isEqualTo("source-bound transcript");
                });
    }

    @Test
    @DisplayName("PostgreSQL tenant-scoped mutations ignore retagged managed entities")
    void postgresMutationsCannotUseManagedTenantRetagging() {
        String owner = "owner-" + UUID.randomUUID();
        String attacker = "attacker-" + UUID.randomUUID();
        AudioFileEntity audio = createAudioFile(owner, "original.wav");
        audioFileRepository.save(owner, audio);
        TranscriptionEntity transcript = createTranscription(owner, "original transcript");
        transcriptionRepository.save(owner, transcript);
        entityManager.clear();

        AudioFileEntity managedAudio = audioFileRepository.findById(owner, audio.getId()).orElseThrow();
        managedAudio.setTenantId(attacker);
        managedAudio.setFileName("forged.wav");
        assertThat(audioFileRepository.updateStatus(attacker, audio.getId(),
                AudioFileEntity.ProcessingStatus.FAILED, "forged update")).isFalse();

        TranscriptionEntity managedTranscript = transcriptionRepository.findById(owner, transcript.getId())
                .orElseThrow();
        managedTranscript.setTenantId(attacker);
        managedTranscript.setText("forged transcript");
        assertThat(transcriptionRepository.softDelete(attacker, transcript.getId())).isFalse();

        entityManager.clear();
        assertThat(audioFileRepository.findById(owner, audio.getId())).get()
                .satisfies(actual -> {
                    assertThat(actual.getTenantId()).isEqualTo(owner);
                    assertThat(actual.getFileName()).isEqualTo("original.wav");
                    assertThat(actual.getStatus()).isEqualTo(AudioFileEntity.ProcessingStatus.PENDING);
                });
        assertThat(transcriptionRepository.findById(owner, transcript.getId())).get()
                .satisfies(actual -> {
                    assertThat(actual.getTenantId()).isEqualTo(owner);
                    assertThat(actual.getText()).isEqualTo("original transcript");
                    assertThat(actual.isDeleted()).isFalse();
                });
        assertThat(audioFileRepository.findById(attacker, audio.getId())).isEmpty();
        assertThat(transcriptionRepository.findById(attacker, transcript.getId())).isEmpty();
    }

    @Test
    @DisplayName("PostgreSQL primary key prevents concurrent tenant overwrite on a new ID")
    void postgresConcurrentInsertCannotOverwriteAnotherTenant() throws Exception {
        UUID sharedId = UUID.randomUUID();
        String tenantA = "race-a-" + UUID.randomUUID();
        String tenantB = "race-b-" + UUID.randomUUID();
        var start = new java.util.concurrent.CountDownLatch(1);
        var pool = java.util.concurrent.Executors.newFixedThreadPool(2);
        try {
            var results = new java.util.ArrayList<java.util.concurrent.Future<Boolean>>();
            for (String tenant : java.util.List.of(tenantA, tenantB)) {
                results.add(pool.submit(() -> {
                    try (EntityManager worker = emf.createEntityManager()) {
                        var repo = new JpaAudioFileRepository(worker);
                        start.await();
                        try {
                            repo.save(tenant, new AudioFileEntity(sharedId, tenant, UUID.randomUUID(),
                                    tenant + ".wav", "/race.wav", "wav"));
                            return true;
                        } catch (RuntimeException rejected) {
                            return false;
                        }
                    }
                }));
            }
            start.countDown();
            boolean first = results.get(0).get(20, java.util.concurrent.TimeUnit.SECONDS);
            boolean second = results.get(1).get(20, java.util.concurrent.TimeUnit.SECONDS);
            assertThat(first).isNotEqualTo(second);
            entityManager.clear();
            String winningTenant = first ? tenantA : tenantB;
            String losingTenant = first ? tenantB : tenantA;
            assertThat(audioFileRepository.findById(winningTenant, sharedId).orElseThrow().getFileName())
                    .isEqualTo(winningTenant + ".wav");
            assertThat(audioFileRepository.findById(losingTenant, sharedId)).isEmpty();
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    @DisplayName("GIVEN audio file WHEN saved THEN can be retrieved from PostgreSQL")
    void testAudioFilePersistence() { 
        // GIVEN
        String tenantId = "tenant-123";
        AudioFileEntity audioFile = new AudioFileEntity( 
            UUID.randomUUID(), 
            tenantId,
            UUID.randomUUID(), 
            "test-recording.wav",
            "/storage/recordings/test.wav",
            "wav"
        );
        audioFile.setDurationSeconds(120); 
        audioFile.setFileSizeBytes(1024L * 1024L); 

        // WHEN
        AudioFileEntity saved = audioFileRepository.save(tenantId, audioFile); 
        entityManager.clear(); // Clear cache to force DB read 

        // THEN
        var retrieved = audioFileRepository.findById(tenantId, saved.getId()); 
        assertThat(retrieved).isPresent(); 
        assertThat(retrieved.get().getFileName()).isEqualTo("test-recording.wav");
        assertThat(retrieved.get().getDurationSeconds()).isEqualTo(120); 
    }

    @Test
    @DisplayName("GIVEN transcription linked to audio file WHEN saved THEN relationship is persisted")
    void testTranscriptionRelationship() { 
        // GIVEN
        String tenantId = "tenant-123";

        // Create and save audio file
        AudioFileEntity audioFile = new AudioFileEntity( 
            UUID.randomUUID(), 
            tenantId,
            UUID.randomUUID(), 
            "interview.mp3",
            "/storage/interviews/interview.mp3",
            "mp3"
        );
        audioFile = audioFileRepository.save(tenantId, audioFile); 

        // Create transcription
        TranscriptionEntity transcription = new TranscriptionEntity( 
            UUID.randomUUID(), 
            tenantId,
            audioFile.getId(), 
            UUID.randomUUID(), 
            "This is a test transcription of the interview.",
            "en"
        );
        transcription.setConfidence(0.95f); 
        transcription.setStatus(TranscriptionEntity.TranscriptionStatus.PROCESSING);

        // WHEN
        TranscriptionEntity saved = transcriptionRepository.save(tenantId, transcription); 
        entityManager.clear(); 

        // THEN
        var retrieved = transcriptionRepository.findById(tenantId, saved.getId()); 
        assertThat(retrieved).isPresent(); 
        assertThat(retrieved.get().getAudioFileId()).isEqualTo(audioFile.getId()); 
        assertThat(retrieved.get().getText()).contains("test transcription");
        assertThat(retrieved.get().getConfidence()).isEqualTo(0.95f); 
    }

    @Test
    @DisplayName("GIVEN soft deleted audio file WHEN queried THEN not returned in results")
    void testSoftDeleteExclusion() { 
        // GIVEN
        String tenantId = "tenant-123";
        AudioFileEntity audioFile1 = createAudioFile(tenantId, "file1.mp3"); 
        AudioFileEntity audioFile2 = createAudioFile(tenantId, "file2.mp3"); 

        audioFileRepository.save(tenantId, audioFile1); 
        audioFileRepository.save(tenantId, audioFile2); 

        // WHEN - soft delete first file
        boolean deleted = audioFileRepository.softDelete(tenantId, audioFile1.getId()); 
        entityManager.clear(); 

        // THEN
        assertThat(deleted).isTrue(); 

        // Should not be found by findById
        var found = audioFileRepository.findById(tenantId, audioFile1.getId()); 
        assertThat(found).isEmpty(); 

        // Count should exclude deleted
        long count = audioFileRepository.countByTenantId(tenantId); 
        assertThat(count).isEqualTo(1L); 

        // findByTenantId should exclude deleted
        var allFiles = audioFileRepository.findByTenantId(tenantId); 
        assertThat(allFiles).hasSize(1); 
        assertThat(allFiles.get(0).getFileName()).isEqualTo("file2.mp3");
    }

    @Test
    @DisplayName("GIVEN soft deleted file WHEN hard deleted THEN permanently removed")
    void testHardDeleteAfterSoftDelete() { 
        // GIVEN
        String tenantId = "tenant-123";
        AudioFileEntity audioFile = createAudioFile(tenantId, "delete-me.mp3"); 
        audioFileRepository.save(tenantId, audioFile); 

        // Soft delete first
        audioFileRepository.softDelete(tenantId, audioFile.getId()); 

        // WHEN - hard delete
        boolean hardDeleted = audioFileRepository.hardDelete(tenantId, audioFile.getId()); 

        // THEN
        assertThat(hardDeleted).isTrue(); 

        // Count in all files (including deleted) should be 0 
        var allFiles = audioFileRepository.findAllByTenantIdIncludingDeleted(tenantId); 
        assertThat(allFiles).isEmpty(); 
    }

    @Test
    @DisplayName("GIVEN multiple tenants WHEN data saved THEN tenant isolation enforced")
    void testTenantIsolation() { 
        // GIVEN
        String tenant1 = "tenant-alpha";
        String tenant2 = "tenant-beta";

        AudioFileEntity file1 = createAudioFile(tenant1, "alpha-file.mp3"); 
        AudioFileEntity file2 = createAudioFile(tenant2, "beta-file.mp3"); 

        audioFileRepository.save(tenant1, file1); 
        audioFileRepository.save(tenant2, file2); 

        // WHEN & THEN
        // Tenant 1 should only see their file
        var tenant1Files = audioFileRepository.findByTenantId(tenant1); 
        assertThat(tenant1Files).hasSize(1); 
        assertThat(tenant1Files.get(0).getFileName()).isEqualTo("alpha-file.mp3");

        // Tenant 2 should only see their file
        var tenant2Files = audioFileRepository.findByTenantId(tenant2); 
        assertThat(tenant2Files).hasSize(1); 
        assertThat(tenant2Files.get(0).getFileName()).isEqualTo("beta-file.mp3");

        // Cross-tenant access should fail
        var crossAccess = audioFileRepository.findById(tenant1, file2.getId()); 
        assertThat(crossAccess).isEmpty(); 
    }

    @Test
    @DisplayName("GIVEN transcription with status WHEN findByStatus THEN returns matching")
    void testFindByStatus() { 
        // GIVEN
        String tenantId = "tenant-123";

        TranscriptionEntity processing = createTranscription(tenantId, "Processing text");
        processing.setStatus(TranscriptionEntity.TranscriptionStatus.PROCESSING);

        TranscriptionEntity pending = createTranscription(tenantId, "Pending text"); 
        pending.setStatus(TranscriptionEntity.TranscriptionStatus.PENDING); 

        transcriptionRepository.save(tenantId, processing);
        transcriptionRepository.save(tenantId, pending); 

        // WHEN
        var processingTranscriptions = transcriptionRepository.findByStatus(
            tenantId,
            TranscriptionEntity.TranscriptionStatus.PROCESSING
        );

        // THEN
        assertThat(processingTranscriptions).hasSize(1);
        assertThat(processingTranscriptions.get(0).getStatus()).isEqualTo(
            TranscriptionEntity.TranscriptionStatus.PROCESSING
        );
    }

    @Test
    @DisplayName("GIVEN concurrent updates WHEN committing stale entity THEN optimistic lock prevents overwrite")
    void testOptimisticLockingOnConcurrentUpdate() { 
        String tenantId = "tenant-lock";
        AudioFileEntity base = createAudioFile(tenantId, "lock.mp3"); 
        AudioFileEntity saved = audioFileRepository.save(tenantId, base); 

        EntityManager em1 = emf.createEntityManager(); 
        EntityManager em2 = emf.createEntityManager(); 
        try {
            AudioFileEntity tx1Entity = em1.find(AudioFileEntity.class, saved.getId()); 
            AudioFileEntity tx2Entity = em2.find(AudioFileEntity.class, saved.getId()); 

            em1.getTransaction().begin(); 
            tx1Entity.setFileName("lock-v1.mp3");
            em1.getTransaction().commit(); 

            em2.getTransaction().begin(); 
            tx2Entity.setFileName("lock-v2.mp3");
            assertThatThrownBy(() -> em2.getTransaction().commit()) 
                .isInstanceOf(RollbackException.class); 
        } finally {
            if (em1.getTransaction().isActive()) em1.getTransaction().rollback(); 
            if (em2.getTransaction().isActive()) em2.getTransaction().rollback(); 
            em1.close(); 
            em2.close(); 
        }
    }

    @Test
    @DisplayName("PostgreSQL repositories reject stale audio and transcript revisions without overwriting current rows")
    void postgresRepositoriesRejectStaleVersions() {
        String tenantId = "tenant-stale-" + UUID.randomUUID();
        AudioFileEntity audio = createAudioFile(tenantId, "revision-zero.wav");
        audioFileRepository.save(tenantId, audio);
        entityManager.clear();

        AudioFileEntity staleAudio = audioFileRepository.findById(tenantId, audio.getId()).orElseThrow();
        entityManager.detach(staleAudio);
        AudioFileEntity currentAudio = audioFileRepository.findById(tenantId, audio.getId()).orElseThrow();
        currentAudio.setFileName("current-audio-revision.wav");
        AudioFileEntity savedAudio = audioFileRepository.save(tenantId, currentAudio);
        assertThat(savedAudio.getVersion()).isGreaterThan(staleAudio.getVersion());
        staleAudio.setFileName("stale-audio-overwrite.wav");
        assertThatThrownBy(() -> audioFileRepository.save(tenantId, staleAudio))
                .hasRootCauseInstanceOf(org.hibernate.StaleStateException.class);
        entityManager.clear();
        assertThat(audioFileRepository.findById(tenantId, audio.getId()).orElseThrow().getFileName())
                .isEqualTo("current-audio-revision.wav");

        TranscriptionEntity transcript = createTranscription(tenantId, "revision-zero transcript");
        transcriptionRepository.save(tenantId, transcript);
        entityManager.clear();

        TranscriptionEntity staleTranscript = transcriptionRepository.findById(tenantId, transcript.getId())
                .orElseThrow();
        entityManager.detach(staleTranscript);
        TranscriptionEntity currentTranscript = transcriptionRepository.findById(tenantId, transcript.getId())
                .orElseThrow();
        currentTranscript.setText("current transcript revision");
        TranscriptionEntity savedTranscript = transcriptionRepository.save(tenantId, currentTranscript);
        assertThat(savedTranscript.getVersion()).isGreaterThan(staleTranscript.getVersion());
        staleTranscript.setText("stale transcript overwrite");
        assertThatThrownBy(() -> transcriptionRepository.save(tenantId, staleTranscript))
                .hasRootCauseInstanceOf(org.hibernate.StaleStateException.class);
        entityManager.clear();
        assertThat(transcriptionRepository.findById(tenantId, transcript.getId()).orElseThrow().getText())
                .isEqualTo("current transcript revision");
    }

    @Test
    @DisplayName("GIVEN invalid entity WHEN save fails THEN transaction is rolled back")
    void testSaveRollbackOnConstraintViolation() { 
        String tenantId = "tenant-rollback";
        long before = audioFileRepository.countByTenantId(tenantId); 

        AudioFileEntity invalid = createAudioFile(tenantId, "bad.mp3"); 
        invalid.setFileName(null); // file_name is NOT NULL 

        assertThatThrownBy(() -> audioFileRepository.save(tenantId, invalid)) 
            .isInstanceOf(RuntimeException.class) 
            .hasMessageContaining("Failed to save AudioFile");

        long after = audioFileRepository.countByTenantId(tenantId); 
        assertThat(after).isEqualTo(before); 
    }

    // Helper methods

    private AudioFileEntity createAudioFile(String tenantId, String fileName) { 
        return new AudioFileEntity( 
            UUID.randomUUID(), 
            tenantId,
            UUID.randomUUID(), 
            fileName,
            "/storage/" + fileName,
            fileName.substring(fileName.lastIndexOf('.') + 1) 
        );
    }

    private TranscriptionEntity createTranscription(String tenantId, String text) { 
        return new TranscriptionEntity( 
            UUID.randomUUID(), 
            tenantId,
            UUID.randomUUID(), 
            UUID.randomUUID(), 
            text,
            "en"
        );
    }
}
