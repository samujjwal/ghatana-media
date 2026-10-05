# Audio-Video Speech-to-Text (STT) Configuration

## Authority

The production STT path is modality-grounded and uses the typed gRPC contract generated from:

```text
modules/speech/stt-service/src/main/proto/stt_service.proto
```

The runtime adapter is:

```text
modules/intelligence/multimodal-service/
  src/main/java/com/ghatana/audio/video/multimodal/adapter/GrpcSttClientAdapter.java
```

Transport security is owned by the typed `SttGrpcTransportSecurity` policy in the same module.
A generic text-completion model is **not** a valid STT fallback. Audio bytes must never be reduced to a base64 text prefix and presented to an LLM as if that were acoustic transcription.

## Supported modes

### `GRPC`

The normal runtime mode. The complete audio payload is sent to the generated STT gRPC client.
TLS is the default transport.

```java
GrpcSttClientAdapter adapter = new GrpcSttClientAdapter(
    "stt.internal.example.com",
    50051,
    GrpcSttClientAdapter.SttMode.GRPC
);
```

Semantics:

- complete audio bytes are transported through the typed STT request;
- the provider owns transcription text and confidence;
- the client applies a bounded RPC deadline;
- provider outage produces an explicit `AudioResult` error;
- no synthetic transcription is generated when the provider is unavailable;
- TLS/mTLS posture is validated before the channel is created.

### `NOP`

Explicitly disables transcription.

```java
GrpcSttClientAdapter adapter = new GrpcSttClientAdapter(
    "localhost",
    50051,
    GrpcSttClientAdapter.SttMode.NOP
);
```

`NOP` is an intentional product/configuration choice. It returns an empty non-error transcription with zero confidence and must not be confused with provider failure.

## Runtime environment

`PlatformMultimodalAdapter` and `SttGrpcTransportSecurity` read:

| Variable | Meaning | Default |
| --- | --- | --- |
| `STT_GRPC_HOST` | STT gRPC service host | `localhost` |
| `STT_GRPC_PORT` | STT gRPC service port | `50051` |
| `STT_GRPC_TRANSPORT_MODE` | `tls`, `mtls`, or explicit local-only `plaintext` | `tls` |
| `STT_GRPC_TRUST_CERT_PATH` | PEM trust certificate/CA bundle used by TLS/mTLS | required in production-like profiles |
| `STT_GRPC_CLIENT_CERT_PATH` | PEM client certificate for mTLS | required for `mtls` |
| `STT_GRPC_CLIENT_KEY_PATH` | PEM client private key for mTLS | required for `mtls` |
| `MEDIA_RUNTIME_ENVIRONMENT` | `local`, `test`, `development`, `staging`, `production`, or `sovereign` | `local` |

The runtime default is `GRPC` over TLS. Plaintext is rejected for staging, production, and sovereign profiles and must be selected explicitly for local/test/development use.

For focused local integration tests, use the explicit test factory instead of weakening runtime configuration:

```java
GrpcSttClientAdapter adapter = GrpcSttClientAdapter.forLocalTesting(
    "localhost",
    50051,
    GrpcSttClientAdapter.SttMode.GRPC
);
```

There is no production `STT_MODE=llm-fallback` configuration. If environment-selectable disablement is required, add it as an explicit typed Media runtime setting whose only accepted values are `grpc` and `nop`; do not reintroduce a text-model fallback.

## Provider contract

The generated request carries the audio bytes directly:

```java
TranscribeRequest request = TranscribeRequest.newBuilder()
    .setAudioData(ByteString.copyFrom(audioData))
    .setSampleRate(16000)
    .setLanguage("")
    .build();
```

The generated response supplies provider-owned transcription and confidence:

```java
TranscribeResponse response = client.transcribe(request);
```

The adapter clamps confidence to the supported `0..1` range and does not manufacture a replacement value when the provider is unavailable.

## Failure behavior

| Condition | Result |
| --- | --- |
| gRPC provider succeeds | Grounded transcription and provider confidence |
| gRPC provider unavailable/deadline exceeded | Explicit error result; empty transcription |
| Empty audio payload | Explicit validation error result |
| `NOP` selected | Intentional empty non-error result |
| Unknown Media runtime profile | Startup/configuration failure |
| Plaintext in staging/production/sovereign | Startup/configuration failure |
| Production TLS without trust material | Startup/configuration failure |
| mTLS without trust/client cert/client key | Startup/configuration failure |

The caller must distinguish `AudioResult.isError()` from an intentionally disabled `NOP` result.

## Deployment requirements

Production deployments that expose STT must provide:

1. a reachable STT gRPC endpoint;
2. compatible generated proto stubs;
3. TLS or mTLS transport with explicit trust material;
4. client certificate/private-key references when mTLS is selected;
5. network policy allowing only the intended Media runtime to reach the endpoint;
6. readiness/dependency truth that marks STT unavailable when the provider or secure transport is unavailable;
7. request-size, concurrency, and timeout limits appropriate to the deployed model;
8. metrics for latency, confidence distribution, request failures, deadline failures, and provider availability.

Do not mark STT production-ready merely because the Media service itself starts.

## Verification

Focused source/unit verification:

```bash
./gradlew \
  :services:media:modules:intelligence:multimodal-service:test \
  --tests '*GrpcSttClientAdapter*' \
  --tests '*SttGrpcTransportSecurityTest' \
  --no-build-cache
```

Production-provider verification must additionally prove a real audio fixture traverses:

```text
Media request
  -> SttGrpcTransportSecurity
  -> TLS/mTLS channel establishment
  -> GrpcSttClientAdapter
  -> generated STT gRPC request carrying full audio bytes
  -> STT provider
  -> typed TranscribeResponse
  -> AudioResult
```

and that provider outage or transport-authentication failure produces explicit degraded/unavailable truth without any alternate text-completion path.
