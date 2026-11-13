# Media scanner-provider / STT lane status (MED-05..MED-09), 2026-11-12

Source: Kernel-first cross-repository execution plan (2026-11-12). All production admission below stays
NOT_ADMITTED; nothing here is real-engine, real-corpus or real-host evidence.

## MED-05 scanner provider: LOCAL_IMPLEMENTED, NOT_ADMITTED
`providers/security-scanner` (`@ghatana-media/security-scanner-provider`): `SecurityScannerProvider` implements
Shared `DocumentContentScanPort` over `ClamdEngine` (clamd INSTREAM, TCP/unix). Signed (HMAC-SHA256/Ed25519, injected
key) attestations carry exact scanned SHA-256, engine/definitions identity and freshness, expiry and Shared
`finality`. UNKNOWN on timeout/drop/oversize/ambiguity/stale/unpinned/busy. Tests use a fake clamd protocol double.
Missing qualification: real pinned ClamAV + freshclam cadence; rights-cleared malicious/safe/polyglot/archive-bomb
corpus with false-negative policy; KMS-custody signing key and rotation; isolation + real clamd crash drill;
Kernel provider admission.

## MED-06 artifact quarantine gate: tests added
`ArtifactScanDecision.admitsRelease` (absent/stale/REJECT/UNAVAILABLE/wrong tenant, principal, upload, digest,
size, type all refuse; MIME/signature is not an input). `DevelopmentMediaArtifactScanner` is asserted never
productionEligible and UNAVAILABLE without the exact object. Existing Postgres/S3 tests already cover
scanner-unavailable/rejected persistence (Docker-dependent; not rerun here).
Follow-up done (remaining-gaps pass): `ArtifactScanDecision` gained an additive nullable `ScanAttestationBinding`
(attestationRef, algorithm, keyId, signature, payloadSha256; the 13-arg constructor still yields an unsigned decision) and
a host-injected `ScanAttestationVerifier`. `admitsSignedRelease(decision, artifact, now, verifier)` additionally requires a
binding and an affirming verifier (missing binding/verifier, rejection or verifier exception => not admitted; signature never
overrides verdict/expiry/identity). Contracts holds no key material: the verifier implementation (checks the signature for
`keyId`, that the canonical payload hashes to `payloadSha256`, and that signed tenant/digest/size/verdict/expiry equal the
decision) is a host obligation, e.g. over the TS `verifyCleanAttestation`. The HTTP service returns the matching
`attestationBinding`. Not done: `S3PostgresqlMediaArtifactStore` still gates on the legacy `matches(...)`; wiring it to
`admitsSignedRelease` plus a real verifier is required before any real scanner is production-eligible
(`MediaArtifactScanSignatureBindingTest`, 5 tests; existing gate tests 6 + 4, all passing under JDK 27).

## MED-05/06 scanner HTTP service (language-neutral endpoint): LOCAL_IMPLEMENTED, NOT_ADMITTED
`ScannerHttpService` (`providers/security-scanner/src/service.ts`, node:http; env-configured entrypoint
`dist/service-main.js`; `FilesystemQuarantineSource`): `POST /v1/scans` (quarantined `objectRef` + expected digest) -> 202,
`GET/DELETE /v1/scans/{id}` (status / idempotent cancel that aborts clamd I/O; 409 after completion), authenticated
`GET /v1/health` (engine + definitions version, pinned/fresh, `admissionState: NOT_ADMITTED`, `productionEligible: false`,
503 when degraded), unauthenticated liveness `GET /healthz`. Authentication is mandatory (constructor refuses to start without
an `authenticate` hook; bearer authenticator provided; mTLS via `tls` option + hook, mTLS itself untested here). Bounds: 16 KiB
body, strict field allow-list, active-scan cap (429), retained-result cap/TTL, header/request timeouts, principal-to-tenant
allow-list. 12 tests against the fake clamd (auth on every route, signed CLEAN/INFECTED/UNKNOWN, outage, bounds, cancel,
tenant isolation, traversal/symlink refusal); full package suite 36 tests passing. Not claimed: TLS termination, caller rate
limiting, real clamd, key custody, Kernel provider admission.

## MED-07 STT (ghatana-media #28): IN_PROGRESS, NOT_ADMITTED
Already present: rights/consent/exact-source admission, profile registry gate, bounded dispatch, cancel/UNKNOWN,
attempt/outbox/reconciliation, provenance-bound `TranscriptDraft`. Added: `MediaSttLanguageQualification` +
`MediaSpeechToTextAdmission.evaluate(..., Registry)` so English and Nepali need separate, exact-tag, unexpired,
evidence-backed, profile-digest-bound entries (default registry empty = nothing admitted); no-auto-sign structural
test; revoke/expiry/restart re-evaluation tests.
Exact missing qualification obligations (not claimable here): pinned model artifact + export rights; independent
reference transcripts and rights-cleared English and Nepali corpora (Common Voice v27 pilot is private/unchecked-in);
per-language WER/CER thresholds with recorded host and CPU/latency; adverse-condition (noise, accent, long audio)
results; reviewed `MediaSttLanguageQualification` entries produced from that evidence; production transcript
version store admission; real recording-consent qualification with PHR/Kernel K-06.

## MED-08 synthetic five-origin capture: docs/script only
Reuse the existing engine unchanged: `@audio-video/client` recorder-orchestrator (`orchestrateScenario`,
`recaptureScenario`), `capture-adapters` (`captureWithAdmission`, browser/http adapters) and production-studio /
interactive-demo. PHR supplies only per-origin scenario scripts and its five builds (doctor, patient, facility,
pharmacy, phr.coordination). Output is a manifest conforming to `schemas/phr-synthetic-capture-manifest.v1.schema.json`:
per-origin build digest, fixture ids, per-scene outcome + source digest, SYNTHETIC privacy block, and explicit
not-clinical/not-STT-evidence flags. `node scripts/phr-synthetic-capture-manifest.mjs digest <build-dir>` and
`validate <manifest> --build-dir doctor=<dir> ...` recompute digests, enforce five distinct origins and scan for
non-synthetic emails/phones/hosts. No real capture was run here.

## MED-09: synthetic consumer/outage/benchmark checks added (NOT qualification)
* (a) `scripts/optional-providers/installed-consumer.mjs` (`npm run test:optional-provider-installed-consumers`): builds and
  `npm pack`s the DI TS client and the scanner provider, extracts them into an empty project together with the unpublished Shared
  peers (`@ghatana/document-extraction`, `@ghatana/documents`, taken from the ../ghatana-shared build, not from a registry), and
  runs a consumer from that project through package-name entrypoints only: scanner signed CLEAN + verifier, HTTP service
  refuses unauthenticated calls, DI `providers()`+`parse()` against a fake worker, `dist/` and `src/` deep imports blocked by
  the exports map, import surface limited to `node:*` / the declared peer. 8 checks pass. Not an immutable published artifact.
* (b) `tests/media-optional-provider-outage-independence.test.mjs` (`npm run test:optional-provider-outage`, 8 tests): DI
  down/hung/garbage => scene-text adapter raises typed `PROVIDER_CATALOG_UNAVAILABLE` (bounded, no result); DI lost after
  discovery => `OUTCOME_UNKNOWN`; scanner down/hung => `UNKNOWN`/`FAILED`, never CLEAN; with either down the other provider and the
  upload content-type admission keep working; both down at once fail independently; speech and runtime-contracts sources have no
  DI/scanner imports. STT/uploads are covered structurally (plus Java STT admission being a pure contract), not by a running
  Media upload/STT service. The control uses the built `libs/audio-video-client/dist` (another session owns that package).
* (c) `scripts/optional-providers/synthetic-benchmark.mjs` (`npm run bench:optional-providers-synthetic`): labelled
  `SYNTHETIC_NOT_QUALIFICATION`; scanner latency percentiles (1 KiB/64 KiB/1 MiB) and bounds (oversize, hung engine, backpressure,
  engine down) against the fake clamd; DI client parse round trip (1 KiB/256 KiB) and bounds (hung worker, oversized response,
  oversized upload) against the fake worker; JSON with an environment fingerprint (node, OS, CPU, load, git commit, dirty flag).
  Loopback in-process numbers only; the host was loaded (load average > 20) in the one smoke run, so no figure is recorded here.
* Still not done: Kernel OCR/scan/STT adapter consumer and Media video/scene-text/upload consumer against published immutable
  versions; real-engine/corpus benchmarks.

## DI copy hygiene (Media copy only; ../ghatana untouched)
`jsonschema` is now declared in the `test` extra of `services/document-intelligence/pyproject.toml` (`uv.lock` not regenerated:
no resolvable offline Python env). `tests/increment6/test_runtime_resilience.py` guards the import of the absent
`document_intelligence.runtime.temp_space` and skips its three TempSpaceGuard tests with a recorded reason; the module is not
reinvented (a history search in the read-only ghatana checkout timed out without finding it; the source defect remains open
there). `MIGRATION-MANIFEST.json` records both as ADAPTED files (new hashes, summary 1478/8/2), updated `knownSourceDefects`,
and states that pytest was NOT re-run after these edits (py_compile only).

## Workspace lockfile
`pnpm install --lockfile-only` (online) succeeded without touching the gltf-validator entry and added only the
`services/document-intelligence/clients/typescript` importer (12 lines); `--frozen-lockfile --lockfile-only` re-validates. The
earlier blocker did not reproduce lockfile-only (it was `--offline` metadata missing for an unrelated package). A full
node_modules install was not attempted.
