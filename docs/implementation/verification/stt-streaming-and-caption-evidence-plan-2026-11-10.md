# Evidence plan: STT streaming and captions

Date: 2026-11-10
Scope: `modules/speech/stt-service`, the locally owned portion of `media.dev.stt-streaming-and-caption`. The launcher caption runtime and PostgreSQL caption/session stores are read-only direct-dependency context.
Purpose: plan verification for F-01/F-02 and all mandatory areas in the companion [closure matrix](stt-streaming-and-caption-mandatory-surface-closure-matrix-2026-11-10.md). This plan does not claim task completion, provider admission, rights/consent, quality, or convergence.

## Current evidence state

The STT subtree had no pre-existing diff. The active `StreamTranscribe` handler rejects before consuming chunks when trusted session/consent admission is unavailable. The validator has direct unit coverage for sequence identity, gaps/duplicates, concurrency, retry-safe rejection, sample-rate/timestamp bounds, and five-minute byte/clock limits. No safe production-code gap was identified from this local scope review. The missing scoped documentation example was added to the module README from the existing proto contract and explicitly marked non-executable while the RPC remains NOT_ADMITTED.

The owning module test completed on JDK 27.0.1.0.2 / Gradle 9.8.2 / macOS 26.2 arm64 with exit code 0: `475` tests, `0` failures, `0` errors, `0` skipped across 49 JUnit XML files. Gradle reported `BUILD SUCCESSFUL` in 2m31s (56 actionable tasks; 4 executed, 52 up-to-date). XML is under `modules/speech/stt-service/build/test-results/test/`. The initial wrapper command could not create a lock in the default user home; the same Gradle 9.8.2 distribution was run with a temporary `GRADLE_USER_HOME` and local lock coordination allowed. This suite ran before the README-only documentation addition; no Java, proto, config, or test source changed afterward.

The repository has no local `tools/` directory or `discover-evidence-tools.mjs`; `docs/EVIDENCE.md` assigns canonical evidence generation to Lifecycle and prohibits hand-authoring `.evidence/**`. Therefore no authoritative score, schema/gate result, receipt, or convergence result can be produced by this plan.

## Scope and repeatability inputs

Owning Gradle unit: `:services:media:modules:speech:stt-service`. Local affected set: all STT module source, proto, build configuration and tests; no public contract, launcher code, persistence schema, dependency, or provider configuration changes are made.

For each run, record `git rev-parse HEAD`, scoped `git status`, JDK/Gradle versions, OS/architecture, exact command, exit code, Gradle log, and JUnit XML. Hash the following scope inputs with `shasum -a 256`:

```sh
shasum -a 256 \
  modules/speech/stt-service/README.md \
  modules/speech/stt-service/build.gradle.kts \
  modules/speech/stt-service/src/main/proto/stt_service.proto \
  modules/speech/stt-service/src/main/java/com/ghatana/stt/grpc/SttGrpcService.java \
  modules/speech/stt-service/src/main/java/com/ghatana/stt/grpc/SttStreamSequenceValidator.java \
  modules/speech/stt-service/src/test/java/com/ghatana/stt/grpc/SttGrpcStreamingSemanticsTest.java \
  modules/speech/stt-service/src/test/java/com/ghatana/stt/grpc/SttStreamSequenceValidatorTest.java \
  docs/implementation/verification/stt-streaming-and-caption-mandatory-surface-closure-matrix-2026-11-10.md \
  docs/implementation/verification/stt-streaming-and-caption-evidence-plan-2026-11-10.md
```

For a repeatability comparison, rerun the same command against the same source/environment fingerprint and compare JUnit test identities and outcomes. A changed worktree, toolchain, selector, or source fingerprint is a new run; do not combine results.

## Ordered local verification

| Order | Command | Proves | Matrix areas |
|---|---|---|---|
| 1 | `GRADLE_USER_HOME=/private/tmp/ghatana-media-stt-gradle-home /Users/samujjwal/.gradle/wrapper/dists/gradle-9.8.2-bin/8wepis63pzuhrlfaiy04bagwu/gradle-9.8.2/bin/gradle :services:media:modules:speech:stt-service:test --no-daemon` | Full unit/contract/in-process suite of the owning STT service; generated proto compilation; current bounds, authentication, stream rejection, and service-local behavior. | surface-kind-build-unit, api-contracts-config, generated-source-of-truth-parity, correctness, security, tests-coverage, build-dependency-release-readiness |
| 2 | Preserve the command's actual JUnit XML under `modules/speech/stt-service/build/test-results/test/` and Gradle log/exit status | Test identity and observed pass/fail/error/skip counts for this exact worktree. | affected-scope-verification, repeatability-reproducibility |

The owning module test is sufficient for the local code state because no production source, public contract, persistence, launcher integration, or dependency changed. It cannot prove the end-to-end task acceptance. After owner prerequisites are available, the affected set must expand to the session authority, provider-attempt fence, launcher caption runtime and durable caption store. Required future checks include accepted partial/final flow, sequence gap/replay, revoke-before-dispatch and revoke-before-disclosure, lost ACK, process restart, exact transcript-parent identity, immutable correction/caption version readback, and zero duplicate provider/persistence effects. Use the owning repository's real source/rights/model inputs only after those inputs are authorized and available.

## Expected evidence and limits

The local run should retain only actual generated compiler/test outputs and the source/environment fingerprint. It establishes module behavior on this worktree. It does not establish lawful audio, trusted consent/purpose, model/export license, real inference, calibrated quality, durable session/provider fencing, restart reconciliation, or caption acceptance.

Proposed generator enhancement for owner review: `EG-MEDIA-STT-STREAMING-CAPTION-PATH-SCOPE-001`, to collect normalized changed-path fingerprints, affected units and selected tests; validate stream authority/finality/caption-parent gates; and emit provenance-bearing schema, gate, score-input, repeatability, and missing-evidence artifacts. This is a proposed capability only, not an accepted Lifecycle task or local substitute. Keep generator-owned schemas, scoring, provenance, receipts, and `.evidence/**` output in Lifecycle.

Open owner/external inputs:

- `media.dev.stream-session-authority`: authenticated canonical session, trusted purpose/consent and current revoke semantics.
- `media.dev.canonical-job-reconciliation`: idempotent provider-attempt fencing and truthful UNKNOWN/restart handling.
- `media.dev.stt-model-and-quality`: exact rights-reviewed model/export, independently authored lawful audio/gold and qualified provider evidence.
- Lifecycle Evidence Generator path/collector/gate route for this scope.
- Exact caption transcript-parent and source-clock persistence/readback across launcher and PostgreSQL owners.

Do not use this plan or local test output to mark the shared task complete or to claim admission, qualification, acceptance, closure, or release.
