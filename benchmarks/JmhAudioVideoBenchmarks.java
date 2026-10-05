package com.ghatana.audio.video.benchmarks;

import com.ghatana.audio.video.infrastructure.persistence.entity.AudioFileEntity;
import com.ghatana.audio.video.infrastructure.persistence.entity.TranscriptionEntity;
import com.ghatana.audio.video.infrastructure.persistence.repository.JpaAudioFileRepository;
import com.ghatana.audio.video.infrastructure.persistence.repository.JpaTranscriptionRepository;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import jakarta.persistence.Persistence;
import org.openjdk.jmh.annotations.*;
import org.openjdk.jmh.runner.Runner;
import org.openjdk.jmh.runner.RunnerException;
import org.openjdk.jmh.runner.options.Options;
import org.openjdk.jmh.runner.options.OptionsBuilder;

import java.util.UUID;
import java.util.concurrent.TimeUnit;

/**
 * @doc.type class
 * @doc.purpose JMH performance benchmarks for Audio-Video persistence layer
 * @doc.layer test
 * @doc.pattern Benchmark
 */
@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.MILLISECONDS)
@State(Scope.Benchmark)
@Fork(value = 2, jvmArgs = {"-Xms2G", "-Xmx2G"})
@Warmup(iterations = 3)
@Measurement(iterations = 5)
public class JmhAudioVideoBenchmarks {

    private EntityManagerFactory emf;
    private EntityManager entityManager;
    private JpaAudioFileRepository audioFileRepository;
    private JpaTranscriptionRepository transcriptionRepository;

    @Setup(Level.Trial)
    public void setup() {
        emf = Persistence.createEntityManagerFactory("audio-video-test");
        entityManager = emf.createEntityManager();
        audioFileRepository = new JpaAudioFileRepository(entityManager);
        transcriptionRepository = new JpaTranscriptionRepository(entityManager);
    }

    @TearDown(Level.Trial)
    public void tearDown() {
        if (entityManager != null && entityManager.isOpen()) {
            entityManager.close();
        }
        if (emf != null && emf.isOpen()) {
            emf.close();
        }
    }

    @Benchmark
    public AudioFileEntity benchmarkSaveAudioFile() {
        String tenantId = "benchmark-tenant";
        AudioFileEntity entity = new AudioFileEntity(
            UUID.randomUUID(),
            tenantId,
            UUID.randomUUID(),
            "benchmark-audio.mp3",
            "/storage/benchmark/test.mp3",
            "mp3"
        );
        entity.setDurationSeconds(120);
        entity.setFileSizeBytes(1024L * 1024L);

        return audioFileRepository.save(tenantId, entity);
    }

    @Benchmark
    public TranscriptionEntity benchmarkSaveTranscription() {
        String tenantId = "benchmark-tenant";
        UUID audioFileId = UUID.randomUUID();

        TranscriptionEntity entity = new TranscriptionEntity(
            UUID.randomUUID(),
            tenantId,
            audioFileId,
            "This is a benchmark transcription for performance testing purposes.",
            "en"
        );
        entity.setConfidence(0.95f);
        entity.setWordCount(12);

        return transcriptionRepository.save(tenantId, entity);
    }

    @Benchmark
    public boolean benchmarkSoftDelete() {
        String tenantId = "benchmark-tenant";

        // Create and save an entity
        AudioFileEntity entity = new AudioFileEntity(
            UUID.randomUUID(),
            tenantId,
            UUID.randomUUID(),
            "delete-test.mp3",
            "/storage/test.mp3",
            "mp3"
        );
        entity = audioFileRepository.save(tenantId, entity);

        // Soft delete it
        return audioFileRepository.softDelete(tenantId, entity.getId());
    }

    @Benchmark
    @BenchmarkMode(Mode.AverageTime)
    @OutputTimeUnit(TimeUnit.MICROSECONDS)
    public long benchmarkCountByTenantId() {
        String tenantId = "benchmark-tenant";
        return audioFileRepository.countByTenantId(tenantId);
    }

    @Benchmark
    @BenchmarkMode(Mode.AverageTime)
    @OutputTimeUnit(TimeUnit.MILLISECONDS)
    public java.util.List<AudioFileEntity> benchmarkFindByTenantId() {
        String tenantId = "benchmark-tenant";
        return audioFileRepository.findByTenantId(tenantId);
    }

    @Benchmark
    @BenchmarkMode(Mode.SampleTime)
    @OutputTimeUnit(TimeUnit.MICROSECONDS)
    public java.util.Optional<AudioFileEntity> benchmarkFindById() {
        String tenantId = "benchmark-tenant";
        // Use a fixed UUID for consistent lookup
        UUID id = UUID.fromString("550e8400-e29b-41d4-a716-446655440000");
        return audioFileRepository.findById(tenantId, id);
    }

    /**
     * Benchmark with multiple threads to test concurrent access.
     */
    @Group("concurrent")
    @GroupThreads(4)
    @Benchmark
    public AudioFileEntity benchmarkConcurrentSave() {
        String tenantId = "concurrent-tenant-" + Thread.currentThread().getId();
        AudioFileEntity entity = new AudioFileEntity(
            UUID.randomUUID(),
            tenantId,
            UUID.randomUUID(),
            "concurrent-test.mp3",
            "/storage/test.mp3",
            "mp3"
        );
        return audioFileRepository.save(tenantId, entity);
    }

    /**
     * Benchmark transcription with large text.
     */
    @Benchmark
    public TranscriptionEntity benchmarkSaveLargeTranscription() {
        String tenantId = "benchmark-tenant";
        StringBuilder largeText = new StringBuilder();
        for (int i = 0; i < 100; i++) {
            largeText.append("This is sentence number ").append(i)
                .append(" in a large transcription benchmark test. ");
        }

        TranscriptionEntity entity = new TranscriptionEntity(
            UUID.randomUUID(),
            tenantId,
            UUID.randomUUID(),
            largeText.toString(),
            "en"
        );
        entity.setConfidence(0.92f);
        entity.setWordCount(largeText.toString().split("\\s+").length);

        return transcriptionRepository.save(tenantId, entity);
    }

    public static void main(String[] args) throws RunnerException {
        Options opt = new OptionsBuilder()
            .include(JmhAudioVideoBenchmarks.class.getSimpleName())
            .forks(2)
            .build();

        new Runner(opt).run();
    }
}
