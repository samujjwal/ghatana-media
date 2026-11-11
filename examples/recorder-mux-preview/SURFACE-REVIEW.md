# Recorder mux preview surface review

**Scope:** `examples/recorder-mux-preview/**` only. This review records the
local synthetic preview consumer. It does not expand the source-authority,
canonical-artifact, production codec, or recorder task boundary.

**Source baseline:** `AGENTS.md`; `docs/development/REMAINING-WORK.md` task
`media.dev.recorder-mux-and-final-artifact`; the task object in
`docs/development/remaining-work.json`; and `docs/development/USABLE-SURFACE-DELIVERY.md#recorder-live`.
The task's local acceptance includes playable mux/readback, caption timing,
partial-export rollback, and duplicate-render fencing. Hosted rights, approved
narration, canonical artifact registration, and J-29 remain outside this local
example's proof.

## Mandatory Surface Closure Matrix (pre-repair)

| Area | Status | Evidence inspected/artifact | Findings | Action |
|---|---|---|---|---|
| Prompt/repo guidance | reviewed-no-gap | Root `AGENTS.md`; no nested `AGENTS.md` under this example; `.github` is absent. | Track A allows ordinary local engineering, preserves authority boundaries, and requires focused tests. | Keep writes under this directory; do not mutate task status or hosted authority. |
| Recursive inventory | reviewed-no-gap | `rg --files examples/recorder-mux-preview`: two preview modules, two tests, two READMEs. | Both consumers and their codec-gated and codec-independent tests are present. | Add one shared transaction module and its test in this example directory. |
| Surface kind/build unit | reviewed-no-gap | `.mjs` modules and `node:test`; root package has no example build unit. | Node ESM consumer; no compile step beyond syntax checking. | Use Node syntax, focused tests, and both CLI consumers. |
| Ownership/boundary/placement | reviewed-no-gap | Example files, root guidance, root README links. | Local-only preview owns generated fixtures and local output only. | Keep canonical upload/runtime out of this scope. |
| Vision/non-goals/consumers | reviewed-no-gap | Both example READMEs and top-level module comments. | Synthetic playable preview is the purpose; no capture, rights, narration approval, publication, or task finality is claimed. | Clarify use and output transaction behavior in the parent README. |
| Architecture/design | gap-found | `preview.mjs` writes into the destination and promotes files separately; multitrack does the same in `multitrack/preview.mjs`. | No bundle transaction or render reservation exists. A failure between MP4 rename and manifest write leaves a partial result. | **F1:** stage the complete bundle beside the destination and atomically promote its directory; clean staging on all pre-commit failures. Test rollback and successful bundle commit. |
| Documentation/examples | gap-found | `README.md` and `multitrack/README.md` document codec setup and readback but not transaction, fence, or stale-lock recovery. | Consumers cannot predict concurrent-run or partial-output behavior. | **F3:** document target path, typed collision result, stale-fence recovery, cleanup guarantees, tests, and local-only limit. |
| Requirements/current-state alignment | gap-found | Exact register acceptance includes rollback and duplicate render fence; code has neither. | Current implementation only checks whether output is empty before starting; this is not a race-safe fence. | Implement F1/F2 against the existing acceptance. |
| Gap/backlog classification | reviewed-no-gap | Task register says READY_FOR_INDEPENDENT_ENGINEERING and explicitly requires both behaviors. | Both are current-state gaps, not new feature work. Codec admission and host publication are separate blockers. | Repair only rollback/fence and bounded local execution. |
| Feature completeness | gap-found | Base and multitrack produce decoded MP4s; each uses sequential renames/writes and has no lock. | Local mux/readback is implemented; rollback/fence are required-missing behavior. Canonical publication is unsupported by design here. | Implement F1/F2; leave hosted publication unsupported. |
| Correctness | gap-found | `preview.mjs` renames video before captions/manifest; `multitrack/preview.mjs` renames video before manifest. Both use `mkdir` + `readdir` as preflight. | File-level commit can expose incomplete bundles; concurrent calls can both observe an empty destination and race. | Implement F1/F2 and assert no partial destination on failure. |
| API/contracts/config | reviewed-no-gap | `createRecorderMuxPreview`, `createLocalMultitrackPreview`, CLI output argument, `GHATANA_MEDIA_FFMPEG` and `GHATANA_MEDIA_FFPROBE`. | Example-only APIs and output names are local. | Preserve function and artifact names; add typed local collision errors. |
| Generated/source-of-truth parity | not-applicable | No generator, generated source, schema, or codegen configuration exists under the example. | All source is hand-maintained. | Keep implementation and tests co-located. |
| Naming | reviewed-no-gap | Existing preview/profile/manifest names and function names. | Names describe the two distinct one-track and multitrack fixtures. | Name shared mechanics for output transaction, not another recorder abstraction. |
| Duplication | gap-found | Both preview modules independently implement destination checking, temporary work cleanup, and final file writes. | Transaction mechanics are duplicated and have the same failure mode. | Implement F1 in one small example-local helper; keep profile-specific encoding/readback separate. |
| Organization/placement | reviewed-no-gap | All relevant source, tests, and docs are already under `examples/recorder-mux-preview`. | Shared mechanics belong beside these two consumers, not in production rendering or shared runtime. | Keep changes within this directory. |
| Cohesion/coupling | reviewed-no-gap | Each preview owns one fixed synthetic profile and no external runtime imports. | A focused filesystem transaction helper remains cohesive and avoids coupling codec profiles. | Keep helper inputs to destination path and producer callback. |
| Tests/coverage | gap-found | `preview.test.mjs` and `multitrack/preview.test.mjs`; pinned pair tests play media and verify readback. | No failure-after-partial-write test, concurrent-process test, or stale-fence/restart test. | Add helper tests for rollback, same-target contention across processes, retained stale fence, and successful commit; rerun real mux selectors. |
| Compatibility/migration/deprecation | reviewed-no-gap | Existing CLI calls use fresh temporary output paths; current non-empty destination is preserved. | No public package contract or migration exists. Keep accepting a fresh or empty destination and preserve non-empty destinations. | Document output behavior; no migration needed. |
| Affected-scope verification | gap-found | Existing selectors are Node tests; the client SDK and DEV_ONLY restart integration directly consume the base CLI. | Affected surface includes both local consumers and direct recorder/artifact/restart consumers. | See the evidence plan below; run direct consumer/build and recorder restart selector where host facilities permit. |
| Evidence Generator integration | not-applicable | Scope is a local example; `AGENTS.md` excludes formal gtool/closure work from this engineering increment. | No example-level Evidence Generator owns local preview acceptance. | Use actual command results, media hashes, FFprobe, and decoder output as local engineering evidence only. |
| Missing Evidence Generator capabilities | not-applicable | No convergence/closure claim requested; no Evidence Generator artifact is needed for this example task. | Creating a separate collector would exceed the current bounded task. | If formal convergence is requested later, create a repo-native evidence enhancement then. |
| Security | reviewed-no-gap | `execFile` receives argument arrays; fixed filenames and generated bytes are written below resolved output/work paths; no shell interpolation or user media is consumed. | Current files are synthetic and local-only. Transaction implementation must not follow an existing destination symlink or overwrite output. | Use exclusive lock creation and same-parent staging; fail closed on collisions. |
| Privacy/data governance/compliance | not-applicable | Fixtures are generated frames/tone/captions; both READMEs state no source rights or authority. | No personal source content, tenant data, or production egress enters this example. | Preserve synthetic labels and limitations in manifests and docs. |
| Observability/diagnostics | reviewed-no-gap | CLI prints `LOCAL_PREVIEW_ONLY` + artifact hash; failures print a typed code or concise error. | Local command output identifies successful artifact and expected local blockers. | Add stable collision/lock error codes and actionable stale-lock text. |
| Reliability/resilience/operability | gap-found | Both implementations clean temporary fixture directories in `finally`, but commit files one at a time and have no inter-process exclusion. | Cleanup does not cover already-renamed files; retry can race or overwrite. | Implement F1/F2 with same-filesystem atomic bundle commit, owner-only lock removal, and safe stale lock retention after process death. |
| Performance/scalability | reviewed-no-gap | Base fixture is fixed 1s/64x64 with small bounded PCM; multitrack caps MP4 at 2 MiB, manifest at 16 KiB, exec buffer at 2 MiB, tool timeout 15s. | Work and output are bounded; base subprocess timeout is missing. | Add a 15s timeout to the base tool wrapper and retain multitrack limits. |
| Accessibility/internationalization | not-applicable | CLI-only example; no visual or interactive UI. | No keyboard/screen reader or locale surface exists. | Keep diagnostics plain and parseable; no UI work. |
| AI/ML applicability | not-applicable | Encoders and fixtures are deterministic; no model or inference path exists. | AI/ML would not improve this validation surface. | Keep exact synthetic oracle and decoder readback. |
| Build/dependency/release readiness | reviewed-no-gap | Node ESM only; codec provisioning script pins FFmpeg 8.1.2 test archive; no dependency is added. | This is not a publishable library or production codec profile. | Run syntax and consumer checks; do not call codec production-qualified. |
| Dependency/supply-chain/licensing | reviewed-no-gap | README and provisioning script describe pinned FFmpeg archive verification and LGPL development build. | No new dependency is proposed. Cached tool availability is local evidence only. | Use the repository's digest-checking provisioner; do not download/install unverified codecs. |
| Repeatability/reproducibility | gap-found | Multitrack test pins MP4 and manifest digests; base manifest records fixture/output digest. | Existing hashes aid repeatability, but failure/concurrency outcomes are not presently captured. | Add deterministic transaction tests and preserve codec-gated exact artifact hash checks. |
| Convergence/stability | reviewed-no-gap | Recorder task is OPEN; docs explicitly separate local preview from J-29/canonical artifact acceptance. | Even complete local rollback/fence does not close external authority, production codec, durable publication, or owner acceptance. | Report local increment and blockers; do not change task state or claim convergence. |

## Findings and repair criteria

### F1 — Partial export is visible after a late failure

- **Priority / area:** P1; architecture/design, correctness, reliability.
- **Where:** `preview.mjs` final rename/write sequence; `multitrack/preview.mjs` final rename/write sequence.
- **Problem:** The MP4 is moved to its public filename before the manifest is written. A later write failure leaves an incomplete export.
- **Root cause:** Multiple files are independently committed in the final directory rather than publishing one complete bundle.
- **Production-ready fix:** Build every output in a private staging directory on the destination filesystem, then commit the complete directory with one rename. Remove staging on codec, probe, readback, manifest, and rename failure.
- **Acceptance:** Failure after staged media and metadata exist leaves no destination files or staging directory. Success exposes the complete manifest/media/caption set together; existing output is preserved.
- **Path-scoped tests:** New transaction unit/integration tests and both pinned preview tests.
- **Path-scoped evidence:** Run both example CLIs, verify MP4 digest/readback, and assert final directory contents.
- **Evidence Generator enhancement:** None for local acceptance; no formal convergence artifact is in scope.
- **Classification / impact:** Current-state gap; closes the partial-export part of local recorder acceptance only.

### F2 — Duplicate render race

- **Priority / area:** P1; architecture/design, correctness, reliability.
- **Where:** Both preview entrypoints' `mkdir`/`readdir` preflight sequences.
- **Problem:** Two processes can both observe an empty directory and write the same output. `-y` is also enabled for the private FFmpeg candidate.
- **Root cause:** A non-atomic preflight check does not reserve a render identity or destination.
- **Production-ready fix:** Acquire a same-destination sidecar lock with exclusive file creation before codec work. Keep the lock while staging and promoting. A collision returns typed `RENDER_IN_PROGRESS`; do not auto-break stale locks on PID guesses. Record enough local metadata to identify the owner, retain crash-stale fences, and document manual recovery after confirming the owner is gone.
- **Acceptance:** Same-process and child-process attempts for one target cannot both enter producer work; distinct targets proceed. A render process hard-stopped after staging leaves its exact lock and private stage; a later process returns `RENDER_IN_PROGRESS` without publishing or cleaning either; a completed render is not overwritten.
- **Path-scoped tests:** New live cross-process transaction test, hard-stop-after-stage regression, retained-stale-fence recovery test, and existing no-overwrite tests.
- **Path-scoped evidence:** Run both CLI consumers with unique output paths; run a cross-process contention test using the production helper.
- **Evidence Generator enhancement:** None for local acceptance; no formal convergence artifact is in scope.
- **Classification / impact:** Current-state gap; closes duplicate-render fencing for the local output path only.

### F3 — Local output transaction contract is undocumented

- **Priority / area:** P2; documentation/examples and affected-scope verification.
- **Where:** `README.md`, `multitrack/README.md`.
- **Problem:** Users are not told that one output path is fenced, that a crash leaves a durable local lock, or how to distinguish a complete bundle from a failed attempt.
- **Root cause:** READMEs predate transaction/fence behavior and describe only the empty-directory policy.
- **Production-ready fix:** Document destination preconditions, lock name/contents, typed concurrent-run result, staging cleanup, stale-lock recovery, test commands, and explicit LOCAL_PREVIEW_ONLY boundary.
- **Acceptance:** A new user can run either example and recover a stale local reservation without touching canonical artifacts; docs match tests and implementation.
- **Path-scoped tests:** Documentation review plus tests that assert error code/message and lock-file lifecycle.
- **Path-scoped evidence:** Re-run focused tests and both README command blocks with the pinned local pair.
- **Evidence Generator enhancement:** None for local acceptance.
- **Classification / impact:** Current-state gap because the operational contract changes; closes documentation for this local example only.

## Security and operability review

- **Input/effect boundary:** Only in-memory synthetic frames, tone, and caption text enter FFmpeg. The local preview does not open capture devices, consume user media, request rights, upload, or publish.
- **Command execution:** `execFile` uses a fixed executable plus argument array; no shell command string or fixture-controlled option is evaluated. Preserve this property.
- **Filesystem boundary:** Resolve the caller-provided output path once; use a same-parent private staging directory and an exclusive sidecar lock. Reject symlink/file destinations and non-empty existing output. Fixed filenames remain inside the stage. Roll back only owned staging/lock paths; never recursively remove a caller's existing destination.
- **Concurrency/recovery:** Lock acquisition is the serialization point. A live collision is typed `RENDER_IN_PROGRESS`. A process crash intentionally leaves the fence rather than risking concurrent output after PID reuse. Recovery requires verifying no owner remains, then deleting only the exact sidecar lock path.
- **Resource bounds:** Keep frame/sample/manifest/MP4 bounds; apply the same 15s subprocess deadline to the base example. No arbitrary user source or unbounded decoding is accepted.
- **Diagnostics:** Emit typed `OUTPUT_EXISTS`, `RENDER_IN_PROGRESS`, `CODEC_UNAVAILABLE`, and `PREVIEW_FAILED`; successful CLI output remains `LOCAL_PREVIEW_ONLY` and includes SHA-256.
- **Privacy/authority:** Continue labeling every manifest local-only. Synthetic clock mapping is not authenticated source PTS, lawful rights, approved narration, canonical lineage, or production qualification.

## Affected-scope evidence plan (pre-implementation)

**Scope fingerprint:** `examples/recorder-mux-preview/**` sources/tests/docs plus the direct recorder consumers discovered by `rg` in `libs/audio-video-client/src/recorder-orchestrator.test.ts` and `integration-tests/src/test/java/com/ghatana/media/integration/MediaDevIssuerHeadlessRestartIT.java`. No public package contract, protobuf, schema, build configuration, or production source is changed.

| Command / artifact | Why sufficient | Matrix areas |
|---|---|---|
| `node --check` on each changed `.mjs` | Parse/ESM syntax check for the owning runtime; no TypeScript/Gradle compile unit exists for this example. | surface kind, correctness, build |
| `node --test examples/recorder-mux-preview/preview-output-transaction.test.mjs examples/recorder-mux-preview/preview.test.mjs examples/recorder-mux-preview/multitrack/preview.test.mjs` with both pinned env vars | Rollback, live process collision, real child-process hard stop after staged output, fail-closed subsequent process, ordinary failure/no-overwrite, exact MP4 hash, FFprobe, independent decoders, captions, exact source-time readback. | tests, correctness, reliability, repeatability |
| Run base and multitrack CLIs to two fresh temp destinations with pinned FFmpeg/FFprobe; read each manifest and hash media | Consumer-visible outputs and atomic bundle shape under the actual pinned local toolchain. | feature completeness, docs/examples, reliability, reproducibility |
| `pnpm --filter @audio-video/client build` | The recorder client suite executes the base preview and passes its resulting real local bytes through the public SDK adapter. | affected-scope verification, compatibility |
| `GHATANA_MEDIA_FFMPEG=... GHATANA_MEDIA_FFPROBE=... pnpm --filter @audio-video/client exec vitest run src/recorder-orchestrator.test.ts` | Direct consumer tests including real-preview bytes-to-publication adapter check; validates no CLI result-shape break. | tests, affected-scope verification |
| `./gradlew --no-daemon -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE -Pghatana.media.compositeScope=FULL :services:media:integration-tests:test --tests com.ghatana.media.integration.MediaDevIssuerHeadlessRestartIT.pinnedRecorderMuxPreviewUploadsThroughPublicSdkAndSurvivesHostRestart` with pinned env vars | Focused real process restart consumer of the CLI output, if local Docker/Testcontainers and the source-composite build are available. It proves only DEV_ONLY synthetic artifact/job readback. | affected-scope verification, reliability, consumer compatibility |
| `git diff --check -- examples/recorder-mux-preview` | Whitespace/conflict-marker check on tracked changed paths; review untracked new files directly because Git omits them from this command. | correctness, repeatability |

**Intentionally not run:** full repository suites, all Gradle integration tests, gtool/PDP/status checks, real capture, production storage/rights/narration, hosted deployment, or production codec qualification. They are outside this example's owned code and cannot establish its local transaction invariants.

**Broader proof would be required if:** changing Media client/runtime contract, canonical storage semantics, or real capture/narration/rights; then run the owning package's public contract and production integration/restart gates under authorized inputs. No such change is planned.

**Repeatability record:** The local archive
`/private/tmp/ghatana-media-codecs/ffmpeg-8.1.2-aarch64-apple-darwin.tar.gz`
was installed into a fresh `/private/tmp/recorder-mux-verified-codec.N1gckC`
root via `GHATANA_MEDIA_CODEC_ARCHIVE_SOURCE=... bash
scripts/prepare-wave2-codecs.sh mac-arm64 ...`. The source-pinned archive
SHA-256 is `ac0babf65798bf681da1dc81c4fe4ae049d0d26e161410174b0e120e3e783332`;
the provision manifest records FFmpeg SHA-256
`5bea4e7be361c9557334f5ae50640c82944304eb5f97d8c248622cf8d1e9bb33` and
FFprobe SHA-256
`b1065dd4a8d4a39b0617818117dadf0502c6bded4314bea3d74bd98b57fa5f7f`.

## Post-repair disposition

| Area | Final status | Verification/current evidence |
|---|---|---|
| Prompt/repo guidance | reviewed-no-gap | Root `AGENTS.md`; no nested example instructions or `.github` guidance. |
| Recursive inventory | reviewed-no-gap | Final inventory includes the two consumers, transaction helper, three test files, READMEs, and this review. |
| Surface kind/build unit | reviewed-no-gap | Node ESM; four changed modules pass `node --check`; there is no separate build unit. |
| Ownership/boundary/placement | reviewed-no-gap | All source/tests/docs remain under this example; runtime/upload code was not changed. |
| Vision/non-goals/consumers | reviewed-no-gap | Parent README now states local consumer purpose, non-goals, API/config, and local-only label. |
| Architecture/design | implemented | `preview-output-transaction.mjs` stages all files and commits the directory once; transaction tests pass. |
| Documentation/examples | implemented | Both READMEs describe output reservation, stale-fence recovery, failure cleanup, and exact focused commands. |
| Requirements/current-state alignment | implemented | Original task acceptance drove rollback, fence, and affected-consumer checks; task status stays OPEN. |
| Gap/backlog classification | reviewed-no-gap | Rollback/fence were required current-state gaps; production rights, capture, narration, codec admission, and canonical finality remain external/open. |
| Feature completeness | implemented | Local mux still produces MP4, captions, manifest, exact clocks and decoded source readback; output is always `LOCAL_PREVIEW_ONLY`. |
| Correctness | implemented | Faults after staged files—including every falsy JavaScript throw—leave no bundle or owned lock; rollback diagnostics preserve non-Error causes and do not mask frozen primary errors. Existing content/symlink targets remain untouched; successful outputs retain prior hashes. |
| API/contracts/config | reviewed-no-gap | Existing consumer functions, filenames, CLI arguments, and environment variables remain stable; collision error is typed. |
| Generated/source-of-truth parity | not-applicable | No generated sources or schemas exist in the example. |
| Naming | reviewed-no-gap | `preview-output-transaction` names shared filesystem mechanics, not a new recording abstraction. |
| Duplication | implemented | Shared destination transaction is implemented once; codecs and profile readbacks remain separate. |
| Organization/placement | reviewed-no-gap | Helper and tests sit beside the two example consumers. |
| Cohesion/coupling | reviewed-no-gap | Helper accepts only destination + producer; no dependency into production Media code. |
| Tests/coverage | implemented | Focused pinned-codec Node suite passes 16/16, zero skips; includes rollback after Error and falsy throws, cleanup failure/cause preservation, live process collision, renderer hard-stop after staged output, fail-closed retry, manual stale-fence recovery, symlink/non-overwrite, and actual codecs. |
| Compatibility/migration/deprecation | reviewed-no-gap | Public preview functions, result shape, and artifact names remain; an empty destination remains accepted. |
| Affected-scope verification | implemented | Client build + recorder Vitest 92/92 and DEV_ONLY recorder artifact/restart selector 1/1 pass. |
| Evidence Generator integration | not-applicable | Local example acceptance uses runnable tests/readback; formal lifecycle evidence is outside this task. |
| Missing Evidence Generator capabilities | not-applicable | No convergence score requested; do not add a collector for this bounded local behavior. |
| Security | reviewed-no-gap | No shell, user-media, or upload path; exclusive lock, path type checks, stage ownership, and no-overwrite cases tested. |
| Privacy/data governance/compliance | not-applicable | All fixture content is generated and local. |
| Observability/diagnostics | reviewed-no-gap | Stable typed destination/lock errors; success prints `LOCAL_PREVIEW_ONLY` and the media digest. |
| Reliability/resilience/operability | implemented | Atomic bundle publication and rollback tests pass; a killed renderer leaves the lock and staged partial output intact, and a later process fails closed without publishing or removing them. |
| Performance/scalability | reviewed-no-gap | Fixed one-second fixtures, MP4/manifest bounds, 2 MiB exec buffer, 15-second codec timeout. |
| Accessibility/internationalization | not-applicable | No UI or localized user content. |
| AI/ML applicability | not-applicable | Exact synthetic fixtures and FFprobe/decode are deterministic; no model is useful here. |
| Build/dependency/release readiness | reviewed-no-gap | Client build passes; no dependency/build configuration changed; local codec is test-only. |
| Dependency/supply-chain/licensing | reviewed-no-gap | Test pair recreated from cached archive after repository SHA verification; LGPL test-only notice retained. |
| Repeatability/reproducibility | implemented | Node suite 16/16, no skips; base/multitrack MP4 hashes are stable and manifest records content hashes. |
| Convergence/stability | reviewed-no-gap | Local gaps are closed; no canonical status, hosted artifact authority, production codec, or J-29 closure is asserted. |

### Final evidence results

- Codec install from local archive: source archive digest verified; fresh
  `PROVISION.json` contains pinned archive and binary digests.
- Focused pinned-codec Node selectors: 16 passed, 0 failed, 0 skipped. The transaction tests cover all falsy thrown values, exact rejection preservation after successful rollback, and cleanup-error reporting when a replacement lock appears; a frozen primary `Error` is retained as the cause. The hard-stop regression launches a renderer child, waits until it writes partial staged media, sends `SIGKILL`, verifies the exact lock and stage persist, then checks a new process returns `RENDER_IN_PROGRESS` and leaves both untouched.
- `pnpm --filter @audio-video/client build`: passed.
- Client recorder consumer selector: 92 passed, 0 failed.
- Base CLI output SHA-256:
  `439f0ba7a8bbcf0bd5765a59011cdae14106c01e82da217a15e5e5fd95bdb8ed`.
- Multitrack CLI output SHA-256:
  `79b58fff905c943b39181b6cf868a29e7c172b76c17f35bfd9f383470bab9ac9`.
- DEV_ONLY artifact/readback across launcher restart: focused integration
  selector passed 1/1 using the verified local codec pair.
- No Gradle `--rerun-tasks` was used. The first integration attempt against an
  incomplete cache lacked `PROVISION.json`; the local source-pinned installer
  repaired that environment input before the successful rerun.

**Final closure decision:** `not-converged-actionable`. This is a local
engineering review, not a convergence score or task-status mutation. The
example still contains only synthetic content and is not an authorized
recording, approved narration/credits, production codec qualification, or
canonical artifact. `media.dev.recorder-mux-and-final-artifact` remains OPEN.
