# infrastructure/persistence

JPA-based persistence layer for the Audio-Video platform.

## Purpose

Provides repository interfaces and JPA entity mappings for audio files and transcription records. All persistence for STT and TTS output flows through this module.

## Layer

`infrastructure` — pure data-access adapter; no domain or business logic. Consumed by `stt-service`, `tts-service`, and `multimodal-service`.

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
