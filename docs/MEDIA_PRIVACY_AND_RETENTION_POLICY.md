# Media Privacy, Consent, and Retention Policy

**Status:** Authoritative requirements + executable implementation map  
**Last Updated:** 2026-08-09  
**Owner:** Media Engineering  
**Compliance Scope:** privacy, tenant isolation, consent, retention, biometric handling, auditability  
**Review Cadence:** on every runtime/privacy boundary change

---

## 1. Purpose and truth rule

This document defines mandatory privacy requirements for Media Runtime and identifies which
requirements are enforced by current executable source.

A requirement in this document is **not** production evidence merely because it is written here.
Implementation claims must point to the canonical runtime contract/provider/launcher path and remain
subject to repository-native verification and the canonical Java/ActiveJ
Evidence Generator owned by `ghatana-lifecycle`.

The Media runtime owns media artifacts, processing jobs, stream sessions, provider routing, and
media-specific consent enforcement. Data Cloud may own governed metadata integrations; AI Inference
may own generic model-provider access. Neither service replaces Media-specific privacy semantics.

---

## 2. Current executable privacy authorities

The current canonical implementation uses these authorities:

| Concern | Executable authority |
|---|---|
| Consent intent | `MediaRuntimeContracts.MediaGovernanceContext` |
| Verified consent | `MediaRuntimeContracts.ConsentDecision` |
| Consent verification SPI | `MediaRuntimeContracts.MediaConsentAuthority` |
| Durable consent verifier | `PostgresqlMediaConsentAuthority` |
| Consent state | PostgreSQL `media_consents` (`V003__media_consent_authority.sql`) |
| External provider residency/egress enforcement | `HttpMediaProcessingProvider`, `HttpMediaStreamingProvider` |
| Physical retention/erasure SPI | `MediaPrivacyMaintenance` |
| Durable S3/PostgreSQL retention authority | `PostgresqlMediaPrivacyMaintenance` |
| Scheduled maintenance lifecycle | `MediaPrivacyMaintenanceRuntime` |
| Upload/stream metadata minimization primitive | `MediaMetadataSanitizer` |
| Durable provider-result minimization | `MediaJobResultSanitizer` + `PostgresqlMediaJobStore` |
| Stream consent restart/termination evidence | durable `StreamSession.metadata` + `MediaRuntime` |
| Governed consent product API | `MediaHttpHandler` + `MediaConsentAdministrationRuntime` |
| Semantic de-identification contract/runtime | `MediaSemanticRedactionProvider` + `MediaSemanticRedactionRuntime` |
| Cross-service governance schema | No schema is checked into this repository; resolve the public owner binding before documenting a local schema path. |

Production promotion must fail if required external processing is configured without a ready,
production-eligible consent authority or without a ready, production-eligible privacy-maintenance
authority.

---

## 3. Data classification and minimization

The following policy classes remain mandatory:

| Data | Minimum posture | Retention rule |
|---|---|---|
| In-flight audio/video frames | Confidential | Do not persist in the Media job ledger |
| Media artifact bytes | Governed by artifact classification | Delete at `MediaArtifact.expiresAt` |
| Upload chunks | Confidential | Delete after completion and when upload expires |
| Transcript/result text | Confidential unless proven de-identified | Do not classify as anonymous without verified redaction |
| Speaker/face/voice biometric vectors | Restricted/Critical | Raw vectors must not enter the durable job ledger |
| Session metadata | Internal/Confidential by content | Minimize sensitive metadata; purge terminal state by configured retention |
| Job metadata/results | Governed by source classification | Purge terminal state by configured retention |
| Consent state | Restricted audit/security metadata | Preserve authoritative grant/revoke/expiry truth per consent policy |

`MediaMetadataSanitizer` structurally removes credential-like values and location/device/container
metadata such as authorization/cookies/tokens/secrets, GPS/geolocation, device identifiers, ID3, and
EXIF fields where the sanitizer is applied. It is a structural minimizer, not semantic PII
redaction.

`MediaJobResultSanitizer` removes raw biometric embeddings/voiceprints, raw media byte fields, and
credential-like provider-result fields before durable PostgreSQL job-result persistence. The stored
result records `privacyRedacted=true` and the field paths removed when minimization occurs.

---

## 4. Consent requirements

### 4.1 Mandatory consent

External audio/video/speech/vision/multimodal processing that handles governed personal media must
have verified, active consent before network dispatch. Biometric operations additionally require an
explicit biometric grant.

Consent decisions are tenant- and principal-bound. A caller-provided `consentId`, purpose, region,
or boolean permission is **intent only** and cannot authorize processing.

### 4.2 Authority-owned permissions

`ConsentDecision` is the authorization result. It carries authority-owned:

- consent identity and authority identity;
- verification and expiry timestamps;
- allowed purposes;
- allowed processing regions;
- external-processing permission;
- biometric-processing permission.

External provider dispatch requires the intersection of caller intent and authority grants. The
caller cannot widen consent by requesting `*`, another purpose/region, or biometric processing.

### 4.3 Revocation and stream termination

Reconnect and frame processing re-verify current consent. Revoked/expired consent therefore blocks
new media processing immediately on the next governed dispatch.

Remote stream termination is different: a revoked grant must not trap an already-open remote
session. `MediaRuntime` persists the last verified non-secret consent evidence with the durable
stream session and may use that evidence only to terminate the previously authorized remote
session. That evidence cannot authorize another frame or reconnect.

### 4.4 Consent administration

`PostgresqlMediaConsentAuthority` verifies durable `media_consents` state.
`MediaConsentAdministrationRuntime` and the authenticated, permission-bound `/api/v1/consents`
routes provide grant/list/read/revoke product operations. The handler binds the authenticated tenant
and principal and does not trust caller approval flags. Direct SQL remains an operational/bootstrap
mechanism, not the customer-facing consent workflow.

---

## 5. Retention and physical erasure

Read-time expiry filtering is not sufficient. Production retention requires physical deletion.

`PostgresqlMediaPrivacyMaintenance` currently enforces:

- S3 artifact deletion before expired `media_artifacts` metadata deletion;
- S3 upload-chunk deletion plus expired upload/chunk metadata deletion;
- configurable retention deletion of terminal processing-job records;
- configurable retention deletion of closed/failed stream-session records;
- bounded purge batches for artifacts/uploads;
- fail-closed behavior when blob deletion fails, leaving metadata for retry/audit.

`MediaPrivacyMaintenanceRuntime`:

- requires a ready production-eligible maintenance provider in production-like profiles;
- runs one purge cycle synchronously before HTTP startup;
- runs later cycles on a single scheduled executor;
- records structured completion/failure logs;
- closes the scheduler/provider with the Media service lifecycle.

Default maintenance interval is 24 hours and is configurable with
`MEDIA_PRIVACY_MAINTENANCE_INTERVAL_SECONDS`. Job and stream retention defaults are 90 days and are
configurable with `MEDIA_JOB_RETENTION_DAYS` and `MEDIA_STREAM_RETENTION_DAYS`.

External provider retention posture is declared with
`MEDIA_HTTP_PROVIDER_DATA_RETENTION=UNKNOWN|NONE|TRANSIENT|PERSISTENT`. `UNKNOWN` is conservative and
cannot make the provider production eligible. A request that forbids provider retention can use only
a provider declaring `NONE`.

Artifact retention is per artifact and comes from the governed upload request.

---

## 6. Transcript and semantic PII redaction

Semantic transcript de-identification remains mandatory before content can be represented as an
anonymous/de-identified tier.

Required semantic coverage includes, where applicable:

- names;
- email and phone identifiers;
- physical addresses/location references;
- financial identifiers;
- health/medical identifiers;
- government identifiers;
- other tenant/domain-specific PII configured by policy.

`MediaSemanticRedactionProvider` is the typed provider contract and
`MediaSemanticRedactionRuntime` is the promotion authority. A requested `DEIDENTIFIED` promotion is
accepted only from an identity-matching provider result that declares `DEIDENTIFIED`, is marked safe
for promotion, and carries policy version, categories, evaluation time, source classification, and
sanitized provenance. External redaction additionally enforces consent, purpose, residency, egress,
and provider-retention posture before disclosure.

No built-in production semantic redaction adapter is selected by default. Without a ready configured
provider, raw transcript/result text remains sensitive and promotion fails closed. Structural
`MediaJobResultSanitizer` output alone is never semantic de-identification evidence.

---

## 7. Biometric handling

Raw speaker/face/voice biometric templates are not ordinary job metadata.

Current executable protections:

- biometric processing requires authority-owned biometric permission before remote dispatch;
- `MediaJobResultSanitizer` removes recognized raw speaker/face/voice embedding/template fields from
  the durable job ledger;
- external processing also requires an authority-permitted region and external-processing grant.

A future dedicated biometric store, if introduced, must define encryption/key ownership, integrity,
consent linkage, deletion, export, and retention contracts explicitly. The current runtime must not
silently treat the generic job-result JSON store as that biometric store.

---

## 8. Cross-border transfer

External processing requires:

1. caller intent allowing external processing;
2. active verified consent;
3. consent authority grant allowing external processing;
4. request purpose allowed by the authority;
5. provider processing region present in both request governance and authority region grants.

`HttpMediaProcessingProvider` and `HttpMediaStreamingProvider` enforce these checks before network
dispatch. Provider hints cannot substitute for consent.

---

## 9. Security and secrets

- Production remote Media HTTP providers require HTTPS and typed credential references.
- Production Media object state uses server-side encrypted S3 objects and PostgreSQL metadata.
- Stream connection tokens are returned once and persisted only as hashes.
- Media provider/job metadata must not persist Authorization headers, cookies, API keys, passwords,
  access/refresh tokens, or other credential material.
- Sensitive content must not be written to normal structured logs.
- Health/readiness may expose provider/maintenance identity and state but not media content or
  credential values.

TLS version/cipher enforcement is deployment/transport configuration evidence and must not be
claimed solely from this policy document.

---

## 10. Verification requirements

The following repository-local verification is required before production promotion:

```text
runtime-contract tests
provider tests
consent authority tests
privacy sanitizer tests
physical retention/erasure provider tests
launcher lifecycle tests
cross-tenant tests
revocation during active stream tests
restart + revocation + termination tests
external-provider region/egress/biometric failure injection
object-store/PostgreSQL restart and partial-failure tests
load/soak for streaming and privacy-maintenance interaction
canonical Java/ActiveJ Evidence Generator gates
```

GitHub Actions status by itself is not scoring evidence.

Production readiness must remain evidence-gated until the required provider-backed verification is
available.

---

## 11. Remaining release blockers

The following are requirements, not implementation claims:

1. A production semantic transcript/PII redaction adapter and deployment evidence for each selected provider.
2. Provider-backed deletion/revocation proofs for all future dedicated transcript/biometric stores.
3. Production load/soak and failure/recovery evidence for privacy maintenance and active streams.
4. Any jurisdiction/product-specific retention schedule not represented by the current generic
   artifact/job/stream retention controls.

---

## 12. Source references

- `runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaRuntimeContracts.java`
- `runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaPrivacyMaintenance.java`
- `runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaMetadataSanitizer.java`
- `runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaJobResultSanitizer.java`
- `providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlMediaConsentAuthority.java`
- `providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlMediaPrivacyMaintenance.java`
- `providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/HttpMediaProcessingProvider.java`
- `providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/HttpMediaStreamingProvider.java`
- `launcher/src/main/java/com/ghatana/media/launcher/MediaRuntime.java`
- `launcher/src/main/java/com/ghatana/media/launcher/MediaConsentAdministrationRuntime.java`
- `launcher/src/main/java/com/ghatana/media/launcher/MediaSemanticRedactionRuntime.java`
- `launcher/src/main/java/com/ghatana/media/launcher/MediaPrivacyMaintenanceRuntime.java`
