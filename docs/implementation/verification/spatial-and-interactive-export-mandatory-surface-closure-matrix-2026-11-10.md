# Mandatory Surface Closure Matrix: `modules/production/spatial`

**Review date:** 2026-11-10<br>
**Scope:** spatial engine, its tests, and module README/build only. Interactive UI, launcher, runtime-contracts, and the shared tracker are outside this review. This is local engineering evidence, not PDP acceptance, export admission, qualification, convergence scoring, or release status.

## Mandatory Surface Closure Matrix

| Area | Status | Evidence inspected/artifact | Findings | Action |
|---|---|---|---|---|
| Prompt/repo guidance | reviewed-no-gap | root `AGENTS.md`; no nested module guidance | Backend engineering is authorized; task state and formal authority must remain separate. | Keep this slice local and task state unchanged. |
| Recursive inventory | reviewed-no-gap | `modules/production/spatial/{README.md,build.gradle.kts,src/main,src/test}`; one Java engine, three test classes | No generated source or hidden module subproject. | Changes remain engine/test local. |
| Surface kind/build unit | reviewed-no-gap | `modules/production/spatial/build.gradle.kts`, root Gradle settings | Java module `:services:media:modules:production:spatial`; JUnit Platform. | Run only affected spatial tests. |
| Ownership/boundary/placement | reviewed-no-gap | module README; `SpatialRigEngine` public records and `SourceRightsPort` | Deterministic CPU engine owns local rig evaluation and bounded GLB construction; no provider/runtime writer. | Preserve module boundary. |
| Vision/non-goals/consumers | reviewed-no-gap | module README opening paragraphs | Narrow explicit frame/profile and local candidate; no calibrated alignment, host viewer, production codec, persistence, or qualification. | Keep limitations visible. |
| Architecture/design | reviewed-no-gap | `SpatialRigEngine.java` records, exporter and `GlbArtifact` constructor | Immutable values, explicit rights port, fixed format profile, exact rationals with FLOAT32 serialization, defensive bytes. | Add payload-boundary validation at artifact readback. |
| Documentation/examples | implemented | `modules/production/spatial/README.md` sections Purpose and boundary, API and local usage, Supported requirements and improvement boundary, Local verification | README now names public flow, rights behavior, local-only output semantics, limitations, and exact test selector. | Keep the local-vs-admitted boundary explicit. |
| Requirements/current-state alignment | reviewed-no-gap | `docs/development/remaining-work.json` task `media.dev.spatial-and-interactive-export`; `USABLE-SURFACE-DELIVERY.md` | Task requires accurate decode/fidelity; explicitly missing registry, transform/loss bindings, viewer, 360 and receipt. | Do not infer unsupported semantics. |
| Gap/backlog classification | reviewed-no-gap | task progress and module README | BIN payload range is current structural correctness gap; registry/viewer/360/output lineage are externally defined task dependencies. | Fix payload range; leave other gaps open. |
| Feature completeness | gap-found | exporter supports one narrow skeleton animation profile; task acceptance requires broader target/viewer fidelity | Local GLB is partial and not task-complete. | Keep task OPEN; no task-state mutation. |
| Correctness | implemented | `SpatialRigEngine.validateGlbExactKeyframeTimes` and `SpatialRigEngineTest.publicGlbArtifactRejectsExactTimeManifestThatDisagreesWithEncodedAnimation` | Original dirty change bound exact rational times to actual FLOAT32 key bytes but bounded against total file length; this repair also bounds declared buffer and actual BIN payload. | Keep both manifest and binary-range regressions. |
| API/contracts/config | reviewed-no-gap | public records in `SpatialRigEngine.java`; no configuration surface | Existing typed API and local metadata are preserved. | No public API changes. |
| Generated/source-of-truth parity | not-applicable | module has no generated code/schema; PDP source is declaration-only for frame semantics | No generator-owned representation is edited. | Keep hand-authored runtime separate from source projections. |
| Naming | reviewed-no-gap | Java package/class/method names and test class names | Names describe rig/export behavior; no naming collision found in module inventory. | No rename needed. |
| Duplication | reviewed-no-gap | module has one exporter and one artifact validator | Test consumer may independently decode persisted artifacts, but this is distinct boundary validation. | Retain independent consumer checks. |
| Organization/placement | reviewed-no-gap | source under `src/main`, tests under `src/test` | Validation belongs at public artifact construction boundary. | Keep check colocated with GLB validator. |
| Cohesion/coupling | reviewed-no-gap | engine imports JDK and Jackson only; caller supplies rights port | No external service/global state coupling. | Preserve deterministic local ownership. |
| Tests/coverage | implemented | `SpatialRigEngineTest` exact-time test and `AnimationJ13LocalScenarioSliceTest`; JUnit XML totals recorded below | Regression redirects the time view into a trailing unknown chunk with matching bytes; validator rejects it. | Preserve boundary regression and adjacent scenario selector. |
| Compatibility/migration/deprecation | reviewed-no-gap | local `GlbArtifact` constructor and output profile | No wire/version change; previously invalid GLB candidates will fail closed. | No migration required. |
| Affected-scope verification | reviewed-no-gap | build module and selectors above | Engine validator change affects spatial unit and scenario tests; example consumer is downstream but unchanged. | Run those selectors only; do not run UI/runtime-contracts. |
| Evidence Generator integration | blocked | `docs/EVIDENCE.md` assigns canonical convergence to Lifecycle-owned generator | No repo-local canonical generator/receipt is available or requested in this lane. | Keep test output as local engineering evidence only. |
| Missing Evidence Generator capabilities | blocked | `docs/EVIDENCE.md`; no module collector/schema found | No local path fingerprint/score-provenance collector. Formal convergence remains Lifecycle-owned. | No substitute collector or `.evidence/**` artifact. |
| Security | reviewed-no-gap | bounded 16 MiB artifact; cloned bytes; typed source-rights port; fail-closed parser | Range arithmetic uses long bounds before reading; no network/path input. | Validate against the actual binary payload boundary. |
| Privacy/data governance/compliance | reviewed-no-gap | README rights/evidence limits; source refs are immutable identifiers | No user content is decoded or persisted by this module. Rights eligibility is caller-provided local boundary. | Do not claim rights from local fixture pass. |
| Observability/diagnostics | reviewed-no-gap | typed export blockers and `IllegalArgumentException` validation errors | Local library has no service telemetry contract. | Preserve actionable validation exception. |
| Reliability/resilience/operability | reviewed-no-gap | bounded GLB size and constructor validation | No durable effects or retries exist in this module. | Fail closed on malformed ranges. |
| Performance/scalability | reviewed-no-gap | hard 16 MiB output ceiling and bounded rig collections | Validation scans a bounded manifest and keyframe count. | Avoid unbounded copies or parsing. |
| Accessibility/internationalization | not-applicable | non-UI Java library | No user-facing controls or localized text contract. | UI accessibility remains owned elsewhere. |
| AI/ML applicability | not-applicable | deterministic geometry/animation serializer with no model/provider | AI/ML adds no value and could not establish geometry truth. | Keep deterministic. |
| Build/dependency/release readiness | reviewed-no-gap | module Gradle dependencies: Jackson, JUnit, AssertJ | Internal module; no publication change. | Use existing build unit. |
| Dependency/supply-chain/licensing | reviewed-no-gap | `build.gradle.kts`; no new dependency proposed | No dependency provenance change in this repair. | No dependency edits. |
| Repeatability/reproducibility | reviewed-no-gap | deterministic exporter and fixed fixture inputs in JUnit | Same fixture produces repeatable GLB bytes and digest checks. | Keep local test deterministic. |
| Convergence/stability | blocked | task remains OPEN; owner profile/registry/viewer/receipt inputs absent | Local structural correctness does not close broader export journey. | Report exact residual inputs; no admission or qualification claim. |

## Findings and evidence plan

### S-01 — Resolved: prevent accessor reads beyond the GLB BIN payload

- **Priority / area:** P1, correctness; **classification:** current-state gap.
- **Where:** `SpatialRigEngine.validateGlbExactKeyframeTimes` and the GLB binary chunk reader.
- **Problem/root cause:** the current validator checks an accessor range against all remaining GLB bytes. It does not cap the range at the BIN chunk payload or declared buffer length, so data in an unknown trailing chunk can be mistaken for animation input bytes.
- **Production fix:** complete. `glbBinaryRange` retains actual BIN payload offset/length; animated documents must declare one buffer whose byte length matches payload length with at most three GLB padding bytes. Accessor view and bytes must fit the declared buffer and the physical BIN payload.
- **Acceptance:** met. A digest-correct artifact with a time accessor redirected into an appended unknown chunk containing matching FLOAT32 times is rejected; generated GLBs pass.
- **Path-scoped tests:** `SpatialRigEngineTest` exact-time/BIN-boundary cases; `AnimationJ13LocalScenarioSliceTest`.
- **Path-scoped evidence:** exact command below passed; JUnit XML `SpatialRigEngineTest` 20 tests and `AnimationJ13LocalScenarioSliceTest` 10 tests, each 0 failures/errors/skips. `git diff --check` passed. No canonical convergence artifact.
- **Evidence Generator enhancement:** none for this local correctness test; Lifecycle-owned generator remains separate.
- **Convergence impact:** closes one malformed-input boundary only; broader task remains OPEN.

### S-02 — Spatial target semantics and viewer qualification remain unavailable

- **Priority / area:** P1, feature completeness; **classification:** external owner dependency / not inferable.
- **Where:** task `media.dev.spatial-and-interactive-export`, PDP-1 `spatialTransformDeclarationContract`, and module README limitations.
- **Problem/root cause:** no selected versioned output profile/coordinate registry, geometry field inventory, transform convention, field-loss binding, qualified viewer, or destination acknowledgment is supplied.
- **Fix/acceptance:** obtain owner-bound inputs and then map only those definitions into code/tests; prove real decoder/viewer parity and output lineage. No local metadata is to be invented.
- **Tests/evidence:** after inputs exist, profile-specific conversion, independent decoder/viewer, orientation/timing, loss, lineage and receipt tests; current local tests cannot prove them.
- **Evidence Generator enhancement:** no local collector can substitute for missing owner definitions or real viewer evidence.
- **Convergence impact:** blocks full task completion; does not block local structural validation.

### Focused verification and repeatability

1. Run `./gradlew -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE -Pghatana.media.compositeScope=FULL :services:media:modules:production:spatial:test --tests com.ghatana.media.production.spatial.SpatialRigEngineTest --tests com.ghatana.media.production.spatial.AnimationJ13LocalScenarioSliceTest --no-daemon --no-parallel --max-workers=2 --console=plain`.
2. Completed run: `BUILD SUCCESSFUL`; JUnit XML at `modules/production/spatial/build/test-results/test/TEST-com.ghatana.media.production.spatial.SpatialRigEngineTest.xml` reports 20/20, and `...AnimationJ13LocalScenarioSliceTest.xml` reports 10/10; both have zero failures, errors, or skips.
3. `git diff --check` completed successfully. Source cut was HEAD `0a439def32fe213aae57d64bcd7f4fc2853d5921` plus the current scoped worktree edits. SHA-256 scope fingerprint: `SpatialRigEngine.java` `3fce634b06bfeab6250d64ed97db4444d98f30436fc7643ef31083f26b8d4899`; `SpatialRigEngineTest.java` `513f5cbed6cb5439804a185468c948911503530e34399b620a777f583466a52e`; `AnimationJ13LocalScenarioSliceTest.java` `f93d40d81fa84b4280dd2546324f23ff0a7c4e0bacde1d87024059930fd3cda5`; `build.gradle.kts` `5d8e816866d6290537aa3eb812671a91634160ffbcbf1aff6c54d6ab308a5004`; `README.md` `a0a2e6cb1ac12506b1b4c8fc65f51fc0e520ffc16f392657ec04c54fee46be87`. Rerunning the same command against these inputs and fixtures is the repeatability check. Build/test reports are local artifacts only.
4. Treat results as local source evidence only; do not change the tracker or claim admitted/qualified spatial output. No local Evidence Generator exists for this authority: `docs/EVIDENCE.md` assigns canonical receipts to Lifecycle.

## Final closure decision

**not-converged-actionable.** One source-owned local correctness repair is in scope. Full export remains OPEN pending the owner profile/registry, transform and field-loss semantics, qualified viewer, rights, output lineage, 360 behavior, and destination acknowledgment. No task-state, admission, or qualification records are changed here.
