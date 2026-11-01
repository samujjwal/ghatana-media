# infrastructure/persistence

JPA-based persistence layer for the Audio-Video platform.

## Purpose

Provides legacy-compatible repository interfaces and JPA mappings for audio files and transcription records. The canonical Media job, artifact, and transcript authority remains the runtime/provider store; this adapter must not become a second active writer.

## Layer

`infrastructure` — compatibility data-access adapter; it does not establish canonical job or transcription finality.

## Key Components

| Class | Responsibility |
|---|---|
| `AudioFileRepository` | Repository interface for audio file metadata |
| `JpaAudioFileRepository` | JPA implementation of `AudioFileRepository` |
| `TranscriptionRepository` | Repository interface for transcription records |
| `JpaTranscriptionRepository` | JPA implementation of `TranscriptionRepository` |
| `AudioFileEntity` | JPA entity for audio file metadata |
| `TranscriptionEntity` | JPA entity for transcription results |

## Configuration

Database connection is configured via the host application's `application.properties` or environment variables:

```properties
spring.datasource.url=jdbc:postgresql://localhost:5432/audio_video
spring.jpa.hibernate.ddl-auto=validate
```

## Dependencies

- Jakarta Persistence (JPA)
- `platform:java:database` — shared connection pool and transaction management

## Testing

```bash
./gradlew :services:media:modules:infrastructure:persistence:test
```

Integration tests use Testcontainers with a PostgreSQL image.

### Transaction and concurrency boundaries

`saveWithTranscription` uses the tenant-checked transcription repository in the
same transaction as the audio save. A failure rolls back a transaction it
started or marks an existing transaction rollback-only. The JPA repositories
hold a supplied `EntityManager`; that object is not safe for concurrent access.
Hosts must provide isolated per-operation persistence contexts or serialize
all use of a shared context, including across both service types. Bounded
service executors alone do not make a shared `EntityManager` thread-safe.
The PostgreSQL integration task uses an isolated generated schema and does not
prove production migration history or a writer cutover.
