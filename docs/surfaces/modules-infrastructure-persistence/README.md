# Surface: `modules-infrastructure-persistence`

JPA-based persistence layer (`modules/infrastructure/persistence`).
Provides legacy-compatible repository interfaces and JPA mappings for
audio files and transcription records.

## Responsibility

- `AudioFileRepository` / `JpaAudioFileRepository` — audio file metadata
  repository interface and JPA implementation.
- `TranscriptionRepository` / `JpaTranscriptionRepository` —
  transcription record repository interface and JPA implementation.
- `AudioFileEntity` / `TranscriptionEntity` — JPA entity mappings.

## Public operations

| Class | Role |
| --- | --- |
| `AudioFileRepository` (+ JPA impl) | Audio file metadata persistence |
| `TranscriptionRepository` (+ JPA impl) | Transcription record persistence |
| `AudioFileEntity`, `TranscriptionEntity` | JPA mappings |

## States and invariants

- **Compatibility data-access adapter only**: the canonical Media job,
  artifact and transcript authority remains the runtime/provider store.
  This adapter must not become a second active writer — no independent
  job or transcription finality is established here.
- Applied-migration history has priority; schema changes follow
  expand → dual-read/backfill → verify → contract. No applied migration
  is altered.

## Dependencies and configuration

- Jakarta Persistence (JPA); `platform:java:database` shared connection
  pool and transaction management.

```properties
spring.datasource.url=jdbc:postgresql://localhost:5432/audio_video
spring.jpa.hibernate.ddl-auto=validate
```

## Errors

Standard JPA/persistence exceptions mapped at service boundaries; this
layer does not define product error taxonomies.

## Tests and commands

```bash
./gradlew :services:media:modules:infrastructure:persistence:test
```

Integration tests use Testcontainers with a PostgreSQL image (Docker
required).
