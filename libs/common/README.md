# Media common library

`libs/common` provides Java primitives shared by Media services. Its public
packages cover request/security context, gRPC transport policy, health,
observability, platform clients, resilience, model metadata, and protocol
helpers. It is consumed by service modules and has no standalone runtime.

## Vision and boundary

Keep cross-cutting transport and lifecycle behavior in one shared implementation
so STT, TTS, Vision, Multimodal, and other Media services apply the same bounded
and fail-closed rules. This library does not own modality processing, product
rights decisions, canonical jobs, provider admission, or production model
qualification. Services remain responsible for supplying current identity,
consent, source, and provider authority to these primitives.

The dependency direction is from service modules to this library. The library
may depend on Media's `libs/java/common` and platform libraries; it must not
depend on Media service modules or create another runtime owner for an engine.

## Main APIs and configuration

- `com.ghatana.audio.video.common.resilience.ContextAwareBoundedExecutor`
  propagates gRPC context to caller-owned bounded workers. `Submission.result()`
  exposes an outcome view; cancellation is classified by the submission so
  started work that may have effects remains `UNKNOWN_OUTCOME`.
- `GrpcTransportSecurityPolicy` selects TLS/client-certificate behavior from
  service-scoped or shared Media certificate configuration.
- `RpcDeadlineServerInterceptor`, `RateLimitingServerInterceptor`, and
  `CircuitBreakerServerInterceptor` implement transport-side limits and
  resilience behavior.
- Health, metrics, platform-client, model, and protobuf helpers live under
  `com.ghatana.audio.video.common.*`.

Each gRPC service accepts a complete service-scoped certificate, private key,
and client CA set using `<SERVICE>_GRPC_TLS_CERT_CHAIN_PATH`,
`<SERVICE>_GRPC_TLS_PRIVATE_KEY_PATH`, and `<SERVICE>_GRPC_TLS_CLIENT_CA_PATH`,
or the corresponding `MEDIA_GRPC_TLS_*` set. A service cannot mix the two
scopes. Production-like profiles require mutual TLS; plaintext is limited to
explicit local/test/development profiles.

## Example

```java
ContextAwareBoundedExecutor.Submission<Response> submission =
    new ContextAwareBoundedExecutor(workerPool).submit(() -> providerCall());
submission.result().whenComplete((response, failure) -> {
    if (failure != null) reportTypedOutcome(failure);
    else sendResponse(response);
});
```

Do not complete or otherwise mutate an executor-owned result from a consumer.
Use `Submission.cancel()` or the result view's cancellation method so the
dispatch fence preserves the correct pre-dispatch versus `UNKNOWN_OUTCOME`
classification. Interrupting the worker is not proof that effect-capable work
did not commit.

## Testing and evidence

Run the library suite with:

```bash
./gradlew :services:media:libs:common:test
./gradlew :services:media:libs:common:test --tests '*InstalledConsumerAbiTest'
```

The installed-consumer selector compiles and runs a separate source file against
the exact Gradle-built `common` JAR and declared runtime JARs. It excludes the
module's main classes directory; this is local archive ABI evidence, not package
publication or consumer admission.

Changes to cancellation, retry, context propagation, auth, or transport limits
also require the directly affected service consumer selectors. Unit and
in-process gRPC tests establish local contract behavior only. They do not
establish four-service production identity parity, external provider admission,
model quality, native leak freedom, or host quota qualification.

For the complete component inventory and current TLS/health/resilience
invariants, see [`docs/surfaces/libs-common/README.md`](../../docs/surfaces/libs-common/README.md).
