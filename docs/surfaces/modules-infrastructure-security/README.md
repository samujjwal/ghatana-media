# Surface: `modules-infrastructure-security`

Security metadata validator for media processing requests
(`modules/infrastructure/security`, single-module infrastructure
adapter, no domain logic).

## Responsibility

- `MediaProcessingSecurityValidator` — validates tenant, permission,
  consent and retention metadata on Data Cloud media processing job
  messages before they reach processing code. Caller-supplied consent
  labels are treated as metadata, never as authoritative authorization
  evidence.
- There is **no** gRPC bearer-token interceptor class in this module today:
  inbound gRPC bearer-token authentication is a platform-owned concern
  (`platform:java:security`) wired at each service's server bootstrap,
  not a Media-implemented interceptor here.

## Public operations

| Class | Role |
| --- | --- |
| `MediaProcessingSecurityValidator` | `validateMediaProcessingRequest(job, requiredPermissions)` and `validateTenantIsolation(...)` return `ValidationResult` (`isValid`, `rejectionReason`, `errorCode`) |
| `ValidationResult` | `valid()` / `rejected(reason, errorCode)` value type — a metadata verdict, not an authorization decision |

## States and invariants

- Non-empty `requiredPermissions` fail closed: the validator holds no
  authenticated principal or permission evidence, so it rejects rather
  than fabricating authorization.
- Consent is only accepted from the `REQUIRED_CONSENT_STATUSES`
  vocabulary (`GRANTED`, `AUTO_APPROVED`); retention policies are
  restricted to `VALID_RETENTION_POLICIES` (`STANDARD`, `SHORT`,
  `LONG`, `NONE`).
- Denial is explicit with a typed error code — never a silent allow.

## Dependencies and configuration

- `platform:java:security` — token crypto/authentication owner (external platform module, not implemented here)
- `platform:java:observability` — rejection metrics
- `modules/infrastructure/messaging` — `TranscriptionJobProducer` message type

## Errors

Invalid or missing request metadata produces a `ValidationResult` with
a typed `errorCode`; callers translate it into their transport's
unauthenticated/failed-precondition semantics.

## Tests and commands

```bash
./gradlew :services:media:modules:infrastructure:security:test
```

Coverage: `MediaProcessingSecurityValidatorTest` exercises valid
metadata, null/missing job, tenant-isolation mismatch, consent outside
the accepted vocabulary, invalid retention policy, and the fail-closed
non-empty-permission path.
