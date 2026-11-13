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
Gap: the Java decision has no signature field; signed-attestation verification for the Media consumer is only in
the TS provider (`verifyCleanAttestation`). A Java signature binding is a follow-up before a real scanner is wired.

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

## MED-09 (partial): scanner outage independence
`providers/security-scanner/scripts/test-installed-consumer.mjs` builds, packs and installs the tarball into an
empty project and runs only the published entry point: zero runtime dependencies, only `node:*` imports, scanner
outage returns UNKNOWN while an unrelated service continues. Not done: the Kernel OCR/scan/STT adapter consumer and
Media video/scene-text/uploads consumer against published immutable versions, DI outage tests (DI service is another
agent's module), benchmarks.
