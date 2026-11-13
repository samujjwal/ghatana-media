# Document Intelligence Java client

This module is a source-free Java transport for the existing frozen `document-intelligence.v1` worker contract. It calls `GET /v1/providers`, `POST /v1/parse`, and generation-bound `DELETE /v1/operations/{operationId}`. It does not add an OCR engine, a v2 protocol, rights authority, or a remote file URL.

The caller supplies an authenticated tenant/principal scope and an immutable source binding. The client checks the tenant/principal match and verifies the image bytes against the declared SHA-256 before dispatch. Those values stay local: v1 request metadata contains only its documented protocol fields. Current rights, consent, and source ownership remain decisions of the caller's authority.

Document Intelligence v1 has no status GET. `status()` therefore returns only a known terminal result from this client process and returns `UNKNOWN` when no exact local result is available. Transport timeout, malformed success, oversized response, or lost cancel acknowledgement never becomes success or confirmed cancellation.

**Coordinates:** `dev.ghatana.documentintelligence:document-intelligence-java-client:0.1.0-SNAPSHOT` (contract `document-intelligence.v1`, recorded in the jar manifest as `Ghatana-Contract-Version`). Public API: `DocumentIntelligenceClient` (`providers`, `parse`, `status`, `cancel`) with `Scope`, `SourceBinding`, `ParseRequest`, `Config`, `CredentialProvider`, `OperationResult`/`State`, `ClientException`.

The module is a standalone Gradle build that reads Media's `gradle/libs.versions.toml` when built in place and falls back to the same pinned versions otherwise. `publishToMavenLocal` produces the jar, sources jar and POM; remote publication, signing and installed-consumer verification are separate approved steps and have **not** been performed. The service credential provider is supplied by the host; the worker's existing v1 route and internal model/provider selection remain the execution boundary.

Cancellation is terminal (`CANCELLED`) only for a 2xx generation-bound acknowledgement that echoes protocol, operation id and generation with `cancelled=true`; every other outcome stays `UNKNOWN`.

## Local verification

```sh
./gradlew -p services/document-intelligence/clients/java test
```
