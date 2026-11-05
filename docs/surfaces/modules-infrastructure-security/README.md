# Surface: `modules-infrastructure-security`

Authentication/authorization interceptor for the audio-video platform
(`modules/infrastructure/security`, single-module infrastructure
adapter, no domain logic).

## Responsibility

- `AuthenticationInterceptor` — gRPC `ServerInterceptor` applied as a
  cross-cutting interceptor in each service's gRPC server bootstrap
  (STT, TTS, multimodal). Validates bearer tokens and populates caller
  context.

## Public operations

| Class | Role |
| --- | --- |
| `AuthenticationInterceptor` | Inbound gRPC authentication; delegates token validation to the platform JWT provider |

## States and invariants

- Token validation is delegated to `platform:java:security`
  `JwtTokenProvider` — this module never implements its own token
  crypto or trusts caller-supplied identity.
- Authentication failures are counted via platform observability
  primitives; denial is explicit, never a silent allow.

## Dependencies and configuration

```properties
security.jwt.secret=${JWT_SECRET}
security.jwt.issuer=ghatana-platform
security.auth.enabled=true
```

- `platform:java:security` — `JwtTokenProvider`
- `platform:java:observability` — authentication failure metrics

## Errors

Unauthenticated/invalid-token requests are rejected by the interceptor
before reaching service handlers; failures surface as gRPC
unauthenticated status, not application errors.

## Tests and commands

```bash
./gradlew :services:media:modules:infrastructure:security:test
```

Coverage: valid/invalid/expired token paths, caller-context population,
failure metrics, interceptor ordering.
