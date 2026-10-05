# infrastructure/security

Authentication and authorisation interceptors for the Audio-Video platform.

## Purpose

Provides a gRPC server interceptor that authenticates inbound requests for all Audio-Video services (STT, TTS, multimodal). Delegates token validation to the platform JWT provider.

## Layer

`infrastructure` — security adapter; no domain logic. Applied as a cross-cutting interceptor in each service's gRPC server bootstrap.

## Key Components

| Class | Responsibility |
|---|---|
| `AuthenticationInterceptor` | gRPC `ServerInterceptor`; validates bearer tokens and populates caller context |

## Configuration

```properties
security.jwt.secret=${JWT_SECRET}
security.jwt.issuer=ghatana-platform
security.auth.enabled=true
```

## Dependencies

- `platform:java:security` — `JwtTokenProvider` for token validation
- `platform:java:observability` — authentication failure metrics

## Testing

```bash
./gradlew :services:media:modules:infrastructure:security:test
```

Tests validate that valid tokens pass through, expired/tampered tokens are rejected with `UNAUTHENTICATED`, and auth-disabled mode allows all requests (dev/test only).
