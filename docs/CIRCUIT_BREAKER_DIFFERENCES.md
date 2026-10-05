# Circuit Breaker Implementation Differences

**Date**: 2026-03-26  
**Document**: AV-007

## Overview

The audio-video codebase contains circuit breaker implementations in three different languages and contexts. This document explains the differences, rationale, and usage guidelines for each.

## Implementations

### 1. Java Server-Side: CircuitBreakerServerInterceptor

**Location**: `libs/common/src/main/java/com/ghatana/audio/video/common/resilience/CircuitBreakerServerInterceptor.java`

**Purpose**: Protects gRPC services from cascading failures by intercepting incoming requests.

**Behavior**:
- Per-method circuit breakers (each gRPC method has its own state)
- States: CLOSED (normal), OPEN (failing fast), HALF_OPEN (testing recovery)
- Configuration via environment variables:
  - `AV_CB_FAILURE_THRESHOLD` (default: 5)
  - `AV_CB_RESET_TIMEOUT_MS` (default: 30000)
  - Legacy aliases `CIRCUIT_BREAKER_FAILURE_THRESHOLD` and `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` are also accepted for compatibility during migration.
- Only counts non-business errors (INTERNAL, UNAVAILABLE, etc.) toward failure threshold
- Business errors (INVALID_ARGUMENT, NOT_FOUND, etc.) do NOT trip the breaker

**When to Use**: All gRPC service methods that call external dependencies or perform heavy computation.

**Integration**:
```java
Server server = ServerBuilder.forPort(port)
    .addService(ServerInterceptors.intercept(service, new CircuitBreakerServerInterceptor()))
    .build();
```

---

### 2. TypeScript Client-Side: CircuitBreaker (audio-video-client)

**Location**: `libs/audio-video-client/src/index.ts`

**Purpose**: Prevents client-side request storms when services are down.

**Behavior**:
- Per-service circuit breakers (STT, TTS, Vision, etc.)
- Same states as Java: CLOSED, OPEN, HALF_OPEN
- Defaults to `failureThreshold=5` and `resetTimeoutMs=30000`, but allows per-service overrides via `ServiceClientConfig.circuitBreaker`
- Works with HTTP status codes (5xx → failure, 4xx → no retry)
- Fails fast with descriptive error message when open

**When to Use**: All HTTP/gRPC-Web client calls from TypeScript UI code.

**Integration** (automatic via AudioVideoClient):
```typescript
const client = new AudioVideoClient({
  stt: {
    endpoint: 'http://localhost:8081',
    timeout: 30000,
    retries: 3,
    enableLogging: true,
    circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30_000 }
  }
} as const);
// Circuit breakers pre-configured for all services
```

---

### 3. Rust/Tauri Client-Side: CircuitBreaker

**Location**: `archive/media-desktop-apps/desktop/src-tauri/src/error_handling.rs`

**Purpose**: Async circuit breaker for Rust-based desktop backend calls.

**Behavior**:
- Async-aware implementation with proper state machine
- Same core states (Closed, Open, HalfOpen)
- Used in conjunction with `RetryConfig` for backoff
- Thread-safe for async/await contexts

**When to Use**: Rust code making calls to Java backend services.

**Integration**:
```rust
let cb = CircuitBreaker::new(5, Duration::from_secs(30));
let result = cb.call_async_for("STT", || async {
  create_channel_with_retry(addr.clone()).await
}).await;
```

---

## Key Differences Summary

| Aspect | Java Server | TS Client | Rust Client |
|--------|-------------|-----------|-------------|
| **Granularity** | Per-method | Per-service | Per-operation |
| **Trigger Errors** | gRPC status codes | HTTP status codes | Any error |
| **Business Errors Ignored** | Yes (INVALID_ARGUMENT, etc.) | Yes (4xx) | Configurable |
| **Configuration** | Environment variables | Per-service config with defaults | Constructor params |
| **Reset Timeout** | 30s default | 30s default | Configurable |
| **State Storage** | ConcurrentHashMap | Map | Atomic state |

## Best Practices

1. **Always have circuit breakers on both sides**: Server-side protects the service, client-side prevents request storms.

2. **Set appropriate thresholds**:
   - Fast operations: 3-5 failures
   - Slow operations: 1-3 failures
   - Consider timeout ratio (if timeout is 30s, reset can be shorter)

3. **Monitor state transitions**: Log OPEN/CLOSED transitions for observability.

4. **Test half-open state**: Ensure recovery is properly detected before closing.

5. **Don't nest circuit breakers**: Avoid having multiple breakers in the same call chain.

## Configuration Guidelines

```bash
# Java server - in service startup script
export AV_CB_FAILURE_THRESHOLD=5
export AV_CB_RESET_TIMEOUT_MS=30000

# TypeScript client - configure in defaultConfigs
const client = new AudioVideoClient({
  stt: {
    endpoint: 'http://localhost:8081',
    timeout: 30000,
    retries: 3,
    enableLogging: true,
    circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000 }
  }
});

# Rust client - in Tauri command
let cb = CircuitBreaker::new(5, 2, 30000);
```

## Testing Circuit Breakers

Java (unit test pattern):
```java
@Test
void circuitBreaker_opensAfterThreshold() {
    CircuitBreaker cb = new CircuitBreaker(3, 1000);
    
    // 3 failures
    for (int i = 0; i < 3; i++) {
        try {
            cb.call(() -> { throw new RuntimeException("fail"); });
        } catch (Exception ignored) {}
    }
    
    assertEquals(State.OPEN, cb.getState());
}
```

TypeScript:
```typescript
test('audio-video client fails fast once the service breaker is open', async () => {
  const client = new AudioVideoClient({
    stt: {
      endpoint: 'http://localhost:8081',
      timeout: 1000,
      retries: 0,
      enableLogging: false,
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 30_000 }
    }
  } as const);

  await client.transcribe({ audio: mockAudio }).catch(() => undefined);
  const result = await client.transcribe({ audio: mockAudio });

  expect(result.success).toBe(false);
  expect(result.error?.code).toBe('STT_ERROR');
});
```

## Migration Notes

When consolidating circuit breaker code (future task):
- Consider extracting to shared library with language bindings
- Standardize on configuration approach (environment vs code)
- Unify metrics and monitoring hooks
- Maintain async compatibility for Rust/TypeScript

## Short-Term Migration Plan

The repo is not ready for a single cross-language circuit-breaker implementation, but the remaining drift should be removed in small steps:

1. Standardize thresholds and reset windows across Java, Rust, and TypeScript.
  - Target baseline: failure threshold `5`, success threshold `2`, reset timeout `30s`.
  - Product-specific overrides should be explicit in config rather than hardcoded in call sites.

2. Keep circuit-breaker ownership service-local.
  - Desktop Rust must use one breaker per backend service.
  - UI TypeScript must keep one breaker per HTTP service endpoint.
  - Java server interceptors stay per gRPC method.

3. Align failure classification.
  - Retryable transport failures: timeouts, `UNAVAILABLE`, `5xx`, `429`.
  - Non-retryable request failures: invalid input, malformed payloads, `4xx` business errors.

4. Add consistency tests at the contract level.
  - Verify `OPEN -> HALF_OPEN -> CLOSED` transitions.
  - Verify non-retryable failures do not increment the same counters as transport failures.
  - Verify per-service breakers do not cross-contaminate each other.

5. Consolidate telemetry naming before code extraction.
  - Emit common state names: `closed`, `open`, `half_open`.
  - Record the service/method label in all breaker transition logs.
