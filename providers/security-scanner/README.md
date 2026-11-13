# @ghatana-media/security-scanner-provider (MED-05)

Optional, independently versioned malware-scanner provider adapter. It implements the Shared
`DocumentContentScanPort` (`scan(input) -> ContentScanAttestation`) over a ClamAV `clamd` engine.

* **Not a Media core dependency.** Nothing in Media runtime, artifact storage or audio/video code
  imports this package; it has zero runtime dependencies (only `node:*`). Kernel binds to it
  structurally (`const port: DocumentContentScanPort = provider`); it never compiles against the
  ClamAV binary. `test/shared-port-compat.typecheck.ts` proves assignability to the real Shared port.
* **Production admission: NOT_ADMITTED.** Only a fake clamd protocol double is exercised here. No
  real ClamAV engine, malicious/safe/polyglot corpus, false-negative policy, or isolation/host
  qualification has been run. Obligations are listed below.

## Public API (`dist/index.js`)

| Export | Role |
| --- | --- |
| `SecurityScannerProvider` | `scan()` returns the base Shared shape; `scanSigned()` the extended typed result |
| `ClamdEngine`, `ClamdEndpoint` | clamd `zINSTREAM`/`zVERSION` over TCP or unix socket; bounded bytes, timeouts, retry of transport failures only |
| `QuarantineSource` | host-supplied bounded reader of quarantined bytes, returns owning tenant |
| `hmacSha256Signer`, `ed25519Signer`, `ed25519Verifier` | injected-key attestation signing/verification (HMAC key >= 32 bytes; no keys in code) |
| `verifyCleanAttestation` | consumer gate: only signed + unexpired + same tenant + exact digest/size + fresh-definitions CLEAN passes |

### Result mapping (forward compatible with the Shared generic scan-result fields)

Base: `scannerRef`, `status` (`CLEAN|INFECTED|FAILED`), `scannedAt`, `checksum`, `scannerVersion`.
Extra optional fields on the same object: `verdict` (`CLEAN|INFECTED|UNKNOWN`; UNKNOWN projects to
`FAILED`), `reasonCode`, `tenantId`, `documentId/documentVersion`, `scannedDigest`/`scannedSizeBytes`
(exact SHA-256 of the bytes actually scanned), `engine{name,version,definitionsVersion,definitionsDate}`,
`signatureName`, `verifiedAt`, `expiresAt`, `attestationRef`, `attestation{algorithm,keyId,signature}`.
New Shared optional fields map field-for-field (digest, scannerRef/version, verdict, verifiedAt,
expiresAt, attestation ref).

### Policy

CLEAN requires: valid request incl. tenant; size within bound; source bytes belong to the requesting
tenant; SHA-256 and size equal the request; engine affirmatively says OK; engine version in the
pinned list; definitions date known and not older than `maxDefinitionsAgeMs`. INFECTED is always
reported. Everything else (timeout, drop, oversize, ambiguous reply, unavailable, stale, unpinned,
busy) is UNKNOWN and carries a signed `reasonCode`.

## HTTP service (language-neutral endpoint for Kernel)

`ScannerHttpService` (node:http, `src/service.ts`; runnable via `npm run build && node dist/service-main.js`, env-configured,
fails closed) exposes the provider over typed JSON. Authentication is mandatory (constructor refuses to start without an
`authenticate` hook; `bearerTokenAuthenticator` provided, mTLS via the `tls` option + hook receiving the verified peer certificate).

| Route | Behaviour |
| --- | --- |
| `POST /v1/scans` | `{tenantId, documentId, version, objectRef, checksum:{SHA-256,hex}, sizeBytes, mimeType, scopeRef?}` -> `202 {scanId,state}`. `objectRef` names a quarantined object resolved by the host `QuarantineSource` (`FilesystemQuarantineSource`: `<root>/<tenant>/<ref>`, no traversal/symlinks) |
| `GET /v1/scans/{id}` | `QUEUED/RUNNING/COMPLETED/CANCELLED`; COMPLETED carries the signed attestation + `attestationBinding` (`attestationRef, algorithm, keyId, signature, payloadSha256`) matching Java `ScanAttestationBinding` |
| `DELETE /v1/scans/{id}` | cancel (idempotent, aborts clamd I/O, result discarded; `409` after completion) |
| `GET /v1/health` | authenticated: engine + definitions version, pinned/fresh, `admissionState: NOT_ADMITTED`, `productionEligible: false`; `503` DEGRADED when engine unreachable/unpinned/stale |
| `GET /healthz` | unauthenticated liveness only |

Bounds: 16 KiB request body, strict field allow-list and identifier patterns, max active scans (429), bounded retained
results with TTL, header/request timeouts, principal-to-tenant allow-list (other principals see 404). No TLS termination,
rate limiting by caller, or deployment hardening is claimed; that is host work.

## Tests

```
node --test --experimental-strip-types test/*.test.ts   # fake clamd: clean, EICAR/infected, timeout, drop, crash+retry, oversized, digest/size/tenant mismatch, stale/unpinned, unsigned/tampered/expired
tsc -p tsconfig.json --noEmit                           # incl. Shared port assignability
node scripts/test-installed-consumer.mjs                # build + npm pack + install + published-entry-point run
```

## Remaining qualification obligations (not claimed)

1. Real pinned ClamAV (`clamd`) deployment, isolated per-scan network/FS, with recorded engine and
   signature-update (freshclam) cadence on the target host.
2. Rights-cleared malicious / safe / format-polyglot / archive-bomb corpus with a documented
   false-negative safety policy and measured detection/latency.
3. Production key custody (KMS/HSM) for the signer and key rotation; Kernel provider admission.
4. Real crash/restart of clamd under load; quarantine storage isolation proof.

## Shared contract binding (@ghatana/documents 0.1.0-SNAPSHOT, development, unpublished)

`finality` (`verdict`, `tenantRef`, `scopeRef`, `sourceRef`, `verifiedAt`, `expiresAt`, `statusRef`,
`attestationRef`, `signatureRef`, `errorCode`) is emitted on every result; INFECTED maps to
QUARANTINED, UNKNOWN stays UNKNOWN with `errorCode` = reason. `test/shared-admission.test.ts` runs
adapter output through Shared `evaluateScanAdmission` and `verifyScanAdmissionFixtures` when
`GHATANA_DOCUMENTS_DIST` points at a compiled `@ghatana/documents` (skipped otherwise, since the
package is not published). Result with a locally compiled dist: all pass.
