# Media Privacy, Consent, and Retention Policy

**Status:** Authoritative requirements + executable implementation map  
**Last Updated:** 2026-10-28  
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
| STT source-rights request and evidence contracts | `MediaSourceAuthorizationContracts.{Request,Evidence,Decision,Authority}`; PostgreSQL versioned source-rights implementation and Shared policy adapter are present on remote `main@e28c755f` (not independently deployed or real-user authenticated) |
| STT pre-job policy/rights/consent/store conjunction | `MediaSpeechToTextAdmission` + `MediaRuntime`; production admission depends on actual installed trusted authority, source, consent, qualified model and transaction readiness |
| Immutable transcript, fenced attempt, and content-free outbox | `PostgresqlMediaTranscriptStore` + canonical PostgreSQL attempt/outbox; conditional production `ADMITTED` source/rights/revocation CAS implemented in V025 on remote `main@e28c755f` but real provider E2E is reported only from inaccessible local commits |
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
- `runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaSourceAuthorizationContracts.java`
- `runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaSpeechToTextAdmission.java`
- `runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaTranscriptContracts.java`
- `providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlMediaTranscriptStore.java`
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


---

## 13. Wave 2 source-rights, model admission and independent acceptance policy

**Policy disposition (2026-10-28): APPROVED FOR ENGINEERING IMPLEMENTATION; NO PRODUCTION RIGHTS OR QUALITY GRANT.** The exact engineering owner execution authority is [the single active Wave 2 plan](implementation/MEDIA-WAVE2-ACTIVE-EXECUTION.md), and the original 58 requirements and 36 unfinished task decisions are in the existing [R8 matrix](implementation/MEDIA-WAVE2-R8-FULL-ACCEPTANCE-MATRIX.json) and [R10 owner gate map](implementation/MEDIA-WAVE2-R10-OWNER-BLOCKER-RESOLUTION.json). This section is a normative Media privacy/security rule, **not** a new approval, PDP phase, provider profile, audit receipt, or duplicative policy engine. All source/code/negative-test work below can proceed now without asking again for routine engineering approval.

### 13.1 One authentic rights and policy decision path (STT first)

- Media is the **source/version/rights record owner** for its own immutable uploads and original production assets; Shared owns the public `PolicyEngine`, `VerifiedPolicyContext`, policy snapshot and decision semantics. Media's `MediaSourceAuthorizationContracts.Authority` is **one composition adapter**, not a policy decision substitute. `MediaConsentAuthority` remains a different revocation-aware authority; the applicable human consent decision cannot be forged or bypassed by a Media receipt.
- The producer/rights holder must authenticate through an **independent trusted security boundary** that binds tenant, principal, creator/rights holder, source artifact ID, immutable source version and actual SHA-256, provenance, permitted operation and purpose, region, retention, permitted transformations/egress, validity and revocation epoch. Store the actual durable signed/attributed provenance and revocation state in a restricted owner-controlled source-of-truth; do not accept a JSON object, caller metadata, user-provided signature/key, an uploaded declaration or an environment flag as independent approval.
- Evaluate the **actual current Shared ALLOW decision** with `VerifiedPolicyContext` created from authenticated identity and an exact source/resource/action/purpose, then intersect it with the current Media source-rights grant, Media consent as applicable, provider/license/locale/model qualification, source clock, source classification and transcript-store readiness. Deny on any missing/stale/mismatched/unknown component. Bound decision freshness and re-evaluate on every provider effect/retry; an old success does not authorize a new effect.
- `MediaSourceAuthorizationContracts.Evidence` is a **validated value returned by a trusted authority**, not a credential solely because its record constructor passed. Its IDs, expiration, permitted scope and revocation epoch must be checked against the actual authority on dispatch and recovery. One successful request cannot be replayed against a different tenant, source hash, model/export, provider, operation or purpose. Race between source-rights revocation and transcript commit requires a transactionally consistent authority snapshot/lock or a documented strong fencing/lease reconciliation; when that cannot be guaranteed, keep the outcome `UNKNOWN` or `NOT_ADMITTED`.
- For durable output, reuse the **existing** Media artifact/job/attempt/fence/outbox and PostgreSQL transcript CAS. A transcript is `CANDIDATE` while its source, profile and commit-time authority are unqualified. Production promotion requires a real successful provider receipt, result digest, expected revision, current source authorization and immutable readback verified at the same authoritative commit boundary. Never simply change the SQL literal `CANDIDATE` or remove the production eligibility check.

### 13.2 First-party engineering media versus real human rights

- **Approved now:** reproducible self-authored nonhuman-generated images, screen flows, VFR videos, simple tones and text fixtures for codec, timing, security, interface and failure-recovery verification, with generator/source SHA, creator-owned immutable artifact and actual scoped rights record. These assets do not grant speaker, face, voice likeness, biometric, training or unrelated third-party rights.
- **Engineering-only speech positive:** an original scripted speech clip may be created using a **separately permitted, genuinely licensed synthetic voice** with explicit rights for this use, bound source/version/owner and independently authored exact words. It is suitable to prove actual speech decoding and a correctly authorized candidate job path when real Media/Shared decisions are verified for that exact request, but **not** to establish human speaker generalization, speaker-disjoint quality, independent human consent or commercial voice rights by itself. An original audio clip recorded by an actual human still requires an authentic scope-specific recording authorization/consent; internal employment or ownership of the software is not consent.
- Any human voice cloning, individual speaker identity, face matching, gaze/face landmarks subject to biometric processing, or outside-party recordings requires **a separately verified rights-holder grant and revocable subject consent** for that exact purpose, along with region, retention, external recipient and revocation. There is no blanket owner override; if unavailable, only that restricted operation remains `NOT_ADMITTED`. All other nonbiometric Media engineering and tests continue.
- An external evaluator/rights reviewer must be an actual independent identity whose signing/approval authority was registered before the evaluation; the current `wave2-trusted-reviewers.v1.json` has **no trusted reviewer keys**. Owner engineers can prepare candidate receipts and a private intake, not self-issue a missing independent final approval.

### 13.3 Model, corpus and native worker decisions

- Official Whisper checkpoint, compatible ONNX export/tokenizer, Piper LJSpeech voice/sidecar, YOLOX Nano weights/export and FLEURS are **candidate artifacts**, independently hash- and license-reviewed before qualified effects. Source-code licenses do not automatically prove derivative weight, voice/personality, dataset redistributions or production model-quality rights. Use exact pinned models/exports with complete independently authored gold; partial text, keyword success, nonexistent EOT or metadata-only corpora cannot establish qualification.
- **Whisper fallback chosen:** first repair source-pinned ONNX encoder/decoder parity; if that fails, evaluate the existing official Whisper reference checkpoint through an isolated, pinned, authorized inference adapter to the **same** Media processing job/attempt SPI. Do not create another job/transcript writer or change the 58 original acceptance rows. A fallback may unblock a genuine local functional result after legal/quality admission, but cannot silently become a production profile.
- **Piper fallback chosen:** actual source-licensed eSpeak-NG-compatible phonemization behind the existing adapter or an independently validated original phonemizer; heuristic mode is nonproduction only. No subject voice/likeness cloning without consent.
- **YOLOX fallback chosen:** a team-owned original nonhuman-object photograph with independent gold boxes is the first functional positive; a rights-reviewed, speaker/subject-disjoint held-out corpus and actual mAP/PR evaluation still gate full accuracy acceptance. Synthetic glyph zero detections remain a valid negative only.
- **FLEURS evaluation:** the original 24-clips-per-locale selection cap now applies to the **pilot**, not the separate qualification holdout. The [source-controlled qualification evaluator](../scripts/qualification/evaluate-fleurs-asr.mjs) reads provisional WER limits and the >=100-holdout-per-locale requirement from the **existing** R10 owner decision map, and reports 95% speaker-cluster bootstrap intervals within the 120 MiB selected-audio budget. These reference thresholds are pre-registered but do **not** constitute a measured score, dataset speaker-rights verification, legal grant or production SLO. Obtain a bounded, attributed, source-revision-pinned, independently labeled subset of `eng`, `hin` and `npi`; select before inference, freeze actual per-clip hashes, speaker identity sources and splits, and preserve corpus/speaker-use rights. Only selected audio, never full tar archives or hundreds of GB, may enter the cache. The public manifest remains `METADATA_ONLY_NOT_FROZEN` pending actual audio and independent gold.
- **Vision JNI/OCI:** the early 4/4 stub, 3/3 real BMP and 54/54 adversarial runs were reported development outcomes. BMP-only proof was **not PNG proof** at that cut. Commit `2180a067` now supplies a separate pinned PNG-capable FFmpeg image plus exact Java PNG pixel tests, and `54471fad` a separate HMAC-authenticated host broker/daemon/client. **Implementation is in source, but production use is not yet qualified:** verify current-cut PNG/native/invalid input tests, server allowlisted image/args, authenticated peer and actual source-owner scope, nonce replay prevention, verified uid/gid, request wall-time and concurrency, resource caps/cleanup and never allow direct Docker CLI fallback in a production Media service. A delegated-cgroup skip never counts as hard sandbox proof; keep the genuine rights and original VIS-03 adversarial contract unchanged.
- **Capacity and alerts:** measure real admitted/completed/rejected/UNKNOWN outcomes on the exact named host at requested 1/16/64; saturation may yield typed rejection but not 64 falsely successful operations. Only real provider quality errors and Alertmanager notification to a named receiver count as integrated observability proof.


### 13.5 Pushed implementation, trustworthy authority and failed model qualification

**Source now accessible (reviewed against GitHub `main@fea2aae5`, seven commits ending `992f77e1`):** PostgreSQL rights records and commit-time revocation checks (V024/V025), real opt-in Whisper→fenced attempt→ADMITTED transcript with reopened PostgreSQL store, actual PNG worker, HMAC OCI broker, YOLOX BGR preprocessing/positive photo and Piper phonemization/PCM source all exist. This does **not** establish actual independent private rights-holder approval, test execution in this source review, complete process-crash recovery or product release. The `MediaAuthorizedSttTranscriptRestartIT` uses a fixture `AllowPolicy`, test-created source provenance, a local artifact store and test HTTPS S3 endpoint; independent production identity, Shared policy and storage must be tested separately.

**No derived trust from request identity or a token alone:** `PostgresqlMediaSourceAuthorizationAuthority.evaluatePolicy` currently creates `PrincipalIdentity` from request tenant/principal and a fresh timestamp. Before production, obtain verified identity from authenticated ingress, validate actor/source owner when registering/revoking rights, and use its current Shared policy decision. A persisted source-rights epoch under DB lock does not by itself atomically validate an external policy-engine revocation. Refuse or reconcile uncertain effects. `MediaOciBrokerDaemon` validates a request HMAC but must additionally enforce per-source owner/right scope, Unix peer credentials, image/argument allowlists, nonce replay defense, wall-clock bounded request reads/concurrency, and no direct Docker permission in the Media service. Avoid treating the three stub broker positive cases as production security certification.

**Multilingual model decision:** user-reported pinned quantized Whisper tiny yields en/hi/ne WER 0.3996/1.0938/1.0448, CI upper 0.454/1.267/1.072, exceeding registered maxima 0.30/0.45/0.55; 89 decoder token caps were counted as empty predictions. **Do not admit this profile as broadly multilingual-qualified** even though one clip reaches EOT after the corrected merged decoder cache. Select a rights-cleared larger/reference model using development data, then qualify on a new blind, speaker-disjoint, source-verified holdout. Public `config/qualification/fleurs-asr-evaluation.v1.json` remains metadata-only; the reported private 380-clip manifest/results require independent hash/split/denominator inspection. The original evaluation scorer requires locale-labelled **holdout only** predictions; focused source corrections `ba9d61fd` and `16dd3044` enforce this but still require Java/Node runtime verification.

**Piper process privacy:** `PiperPhonemizeProcessConverter` presently does blocking stdin/stdout before the 15-second `waitFor`, so total deadline is not yet enforced; the temporary stderr log is not removed by observed code. Require bounded asynchronous pumps, one deadline, descendant kill, private log cleanup and dependency-data pins before production voice activation. LibriTTS-R dataset license or audible generic voice alone is not voice likeness/clone consent.

See [current active Wave 2 §7.6](implementation/MEDIA-WAVE2-ACTIVE-EXECUTION.md#76-pushed-source-review--corrected-priorities-and-executable-acceptance). These rules authorize ordinary engineering and first-party nonhuman tests but grant no rights, reviewer credibility, model quality, deployment or Lifecycle/gtool acceptance.

### 13.4 Restricted evidence and acceptance accounting

Proof files can contain nonsecret IDs/digests/versions, source revision, profiler results and public test source. Full identity documents, consent forms, reviewer private keys, raw media containing personal data and rights-holder communications remain in the access-controlled intake—not in public Git or application logs. In the absence of a real trust anchor or authority, record `EXTERNAL_INPUT_UNAVAILABLE` with owner, evidence type and recheck point rather than inventing approvals.

All 36 remaining tasks retain their original `PARTIAL` or `OWNER_EXTERNAL` ledger status. Engineering permission and passing unit/OCI fixtures **never** promote a row until its original positive, negative, fault/restart, privacy, source-rights and quality expectations are independently satisfied. PDP closure, operational writer migration, deployment and release remain different gates.
