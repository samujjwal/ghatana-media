# Post-PDP dependency and migration owner/cutover checklist

**Observed:** 2026-10-12 (Pacific time)
**Authority:** local source and checkout observation only
**Canonical runtime:** `ghatana/services/media` remains canonical under [`BOUNDARY.md`](../../BOUNDARY.md).
**Decision:** this record prepares owner review; it is not owner approval, an admitted cutover manifest, a transfer receipt, package qualification, or authorization to move source or activate a workflow.

## Task dispositions

| Task | Current disposition | Evidence and remaining completion condition |
|---|---|---|
| DEP-01 | `EXTERNAL_PENDING_PUBLIC_ARTIFACTS` | Checked-out build declarations identify Shared/Tools/Kernel APIs, but key TypeScript dependencies are `0.1.0-SNAPSHOT`; Media also uses sibling composite/workspace sources. No immutable artifact digest, complete transitive license set, or source-free installed-consumer result was established in this pass. Owners/publishers must supply compatible immutable versions and the consumer must pass isolated tests. |
| DEP-02 | `EXTERNAL_PENDING_SHARED_REVIEW` | `libs/audio-video-ui` consumes Shared design-system/theme/tokens and exports tokens; its manifest pins snapshots. This does not establish an immutable public binding or Shared review. Shared #234 must review exact exported primitives, token/CSS behavior, and package version. Strict CSP, forced-colors, reduced-motion, keyboard, and independent accessibility evidence remain required. |
| DEP-03 | `EXTERNAL_PENDING_IDENTITY_CONTRACT` | Media's build and migration records do not establish a Shared-qualified trusted continuation/workspace-membership contract or accepted tenant/principal/delegation tuple. Shared #242 must identify the exact public version and authority behavior; Media must retain fail-closed stale/revoked/cross-tenant tests. |
| DEP-04 | `EXTERNAL_PENDING_PLATFORM_BOUNDARIES` | The checked-out source set includes Data Cloud compatibility routes and generic platform APIs, but no owner acceptance of the Action/Event Plane, Data Cloud read model, or AI Inference boundaries was established. Ghatana #254 must accept exact source/result/idempotency/event-append semantics separately from consumer finality. |
| MIG-01 | `LOCAL_SCAN_REFRESHED_OWNER_REVIEW_PENDING` | The latest generated committed-tree crosswalk pins source `65567dfff57d5ee9f5d7e8479dd311e5a7b6895d` / Media tree `f73623d95f7951d7b265d1add23867c1df9a0a84` and target `81386992d273a98237451702c2daf618c77c8e51`; it compares 652 paths (537 identical, 103 different, 12 absent). It does not cover every release branch or deployment environment and has no named-consumer-owner confirmations. Complete exact route, protobuf, SDK and event before/after inventories and record owner dispositions before cutover. |
| MIG-02 | `PLAN_PREPARED_OWNER_AUTHORIZATION_PENDING` | The checklist below defines reversible gates and rollback evidence while preserving MDI-001 ownership. A named source owner must approve the per-path transfer manifest, source of truth, rollback authority and execution window before any source move. |
| MIG-03 | `BLOCKED_ON_MIG_01_MIG_02_ADMISSION` | Build identity and generated public artifact comparison must follow accepted consumer parity and cutover admission. Keep `audio-video`, `services:media`, and legacy Tools aliases until each consumer has a tested binding. |
| MIG-04 | `BLOCKED_ON_OWNER_AUTHORIZED_CUTOVER` | No source transfer, runtime switch, consumer rebinding, deprecation, workflow activation or rollback rehearsal was performed. Execute only after MIG-01/02 gates are signed and admitted. |

These statuses describe this preparation pass. `EXTERNAL_PENDING_*` is not an owner rejection, and local source availability is not public artifact availability.

## Initial local revision snapshot (historical)

The following are the initial checked-out revisions inspected during this review. A later source/target comparison appears below and is the current local committed-tree observation. “Clean” means no output from `git status --short` for that repository; it does not mean remote branches or deployed environments were checked.

| Repository | Checkout | HEAD | Scope note |
|---|---|---|---|
| `samujjwal/ghatana` | `main` | `688c948cdf815738deb73d0d49f139e0ea45be26` | `HEAD` is `origin/main`. The committed `services/media` tree is `d1045620fccc893f30ca35f8eff364fd88635e3b`. Current worktree has pending OpenAPI, runtime-contract, handler-test, and contract-test changes under `services/media`; these are not included in the committed-tree path comparison below. |
| `samujjwal/ghatana-products` | `main` | `7c008d932f6ed6c2e6d7df0d1e43b82fc592d08f` | Clean. |
| `samujjwal/ghatana-media` | `main` | `0837fefe303acb7fe7fc4403a35ed33786551ee7` | Shared checkout contains this task's in-progress implementation and verification changes plus other lane edits; working tree is not clean. |
| `samujjwal/ghatana-kernel` | `main` | `4521f6af7d8206805e4515c0415da772f6f239d8` | Clean. |
| `samujjwal/ghatana-shared` | `main` | `b1b401a9aa7835b22686787942bf8cbe0fbb0f4a` | Clean. |
| `samujjwal/ghatana-tools` | `main` | `00618e036ea706d3165e9d8ca53ae14f37fa6f52` | Clean. |
| `samujjwal/ghatana-yappc` | `main` | `74a96183dda43a6e43823b3d048cf7fabb84a1f9` | Clean. |
| `gharbatai` | `codex/five-demo-hardening` | `96fe7b1ee5424ea186edf78ac19bd743d90fef2d` | Branch is not `main`; treat as a bounded consumer observation only. |
| `samujjwal/ghatana-lifecycle` | `main` | `556d6ef84c6baf01171cae354bf7d631af23823b` | Clean. |
| `samujjwal/ghatana-toolchain` | `main` | `61989587ad9619504c409e9b57ad4c5817d0e816` | Clean. |

This is a reproducible local checkout inventory, not an exhaustive current consumer scan. Repeat on owner-agreed release branches and deployment configurations; confirm the target revisions immediately before any cutover. Prior consumer inventory evidence remains useful but explicitly bounded; do not upgrade its old scope into complete owner-reviewed parity.

## Earlier source-to-target comparison (historical baseline)

The original comparison below was taken before the canonical source advanced from `363a801ea96bcea518e3e5a7b6aec735f26e261a` to `688c948cdf815738deb73d0d49f139e0ea45be26`. Preserve it as dated evidence; use the refreshed comparison below for current committed trees.

Compared committed trees at source `ghatana` HEAD `363a801ea96bcea518e3e5a7b6aec735f26e261a` and target `ghatana-media` HEAD `0837fefe303acb7fe7fc4403a35ed33786551ee7`. The source `services/media` worktree was clean at inspection and its current tree object was `1de4f7ab103374161b00bea6e5da9c4cf0c31a75`. The transfer/path-map snapshot commit `245e966591913bc73f59fad9bf43651673b0280e` is stale relative to this source HEAD.

| Comparison result | Count |
|---|---:|
| Tracked source paths under `services/media/` at current source HEAD | 647 |
| Same relative target path with exact Git mode and blob ID | 537 |
| Same relative target path, but mode or blob differs | 103 |
| No same-relative-path target entry | 7 |

This is a scoped path-mapping diagnostic, **not owner-reviewed parity and not a passed migration**. It compares each source path after stripping `services/media/` to the same relative path at target HEAD, then compares Git mode and blob ID. It does not infer that every absent or changed path is an error: `README.md`, build files, generated contract projections and other paths have documented or potential intentional exceptions. Reconcile all 103 differences and 7 absent paths against authored-source ownership, `migration/path-map.yaml`, `migration/transfer-exceptions.yaml`, and the transfer receipt; record a per-path disposition and owner review before claiming parity.

Reproduction used these read-only revision/cleanliness commands:

```sh
git -C /home/samujjwal/Developments/ghatana rev-parse HEAD
git -C /home/samujjwal/Developments/ghatana rev-parse HEAD:services/media
git -C /home/samujjwal/Developments/ghatana status --short -- services/media
git -C /home/samujjwal/Developments/ghatana-media rev-parse HEAD
```

For the path comparison, a Python 3 read-only snippet invoked `git ls-tree -r -z HEAD -- services/media/` in the source repository and `git ls-tree -r -z HEAD -- .` in the target repository. It parsed each NUL-delimited tree entry's mode and blob ID, stripped the source `services/media/` prefix, then counted same-relative-path target entries and exact `(mode, blob ID)` matches. The counts reconcile: `537 + 103 + 7 = 647`.

## Earlier refreshed committed-tree path comparison

Compared source `ghatana/services/media` at HEAD `688c948cdf815738deb73d0d49f139e0ea45be26` (`services/media` tree `d1045620fccc893f30ca35f8eff364fd88635e3b`) to target `ghatana-media` at HEAD `0837fefe303acb7fe7fc4403a35ed33786551ee7`. The canonical source worktree also contains uncommitted OpenAPI/runtime-contract follow-up changes that are not part of these committed-tree counts. The target worktree has task changes that are likewise not included.

| Comparison result | Count |
|---|---:|
| Tracked source paths under `services/media/` at current source HEAD | 652 |
| Same relative target path with exact Git mode and blob ID | 537 |
| Same relative target path, but mode or blob differs | 103 |
| No same-relative-path target entry | 12 |

These counts reconcile: `537 + 103 + 12 = 652`. This remains a bounded path diagnostic, **not owner-reviewed parity or migration acceptance**. The additional committed source paths and changed runtime source need exact authored-source and consumer dispositions; do not infer an error or a migration requirement from a path count alone. Reproduce using the read-only commands and `git ls-tree -r -z` comparison method documented in the historical section.

## Current local checkout comparison after the owner directive

On 2026-10-12, I re-ran the exact committed-tree comparison from the checkouts available to this task. The source checkout is on `codex/eni-v7-3-source-progress-2026-10-12` at `65567dfff57d5ee9f5d7e8479dd311e5a7b6895d` (Media subtree `f73623d95f7951d7b265d1add23867c1df9a0a84`); the target checkout is on `main` at `81386992d273a98237451702c2daf618c77c8e51` (tree `f8a676607a7ef5ab13450b91a44a7570d0140680`). Since the prior `8d17593` observation, source HEAD advanced through AEP-only commits; the Media tree and path counts remain unchanged. The source checkout differs from the owner directive's reviewed `ghatana@fd6d91f` cut. This is a bounded observation of local `HEAD`, not a replacement for the reviewed source cut or an agreed release-branch inventory.

| Comparison result | Count |
|---|---:|
| Tracked source paths under `services/media/` | 652 |
| Same relative target path with exact Git mode and blob ID | 537 |
| Same relative target path with a different mode or blob ID | 103 |
| No same-relative-path target entry | 12 |

The counts reconcile: `537 + 103 + 12 = 652`. The full per-path modes, blob IDs, and classifications are in [`media-source-target-tree-crosswalk-2026-10-12.json`](evidence/media-source-target-tree-crosswalk-2026-10-12.json), generated with `pnpm report:media-source-target-tree`. The direct comparison does not apply relocations or infer semantic ownership. The 12 absent same-path entries include the two quarantined Gitea workflow candidates, the source `gradle` symlink replaced by target-local wrapper/catalog files, and `service-contract.yaml`, which remains a generated projection; nine other source paths still need explicit disposition. All 103 changed same-path entries remain unclassified by this comparison. Therefore MIG-01 remains `LOCAL_SCAN_REFRESHED_OWNER_REVIEW_PENDING`; this new tree evidence does not close the contract, consumer-owner, or release-branch parts of that task.

Both checkouts had active worktree edits during this execution. The report compares committed `HEAD` trees only; delegated implementation edits and unrelated uncommitted AEP work in the source checkout are excluded. Do not use these counts as a source transfer manifest or as approval to change canonical authority.

## Public dependency/source observations

| Owner boundary | Checked-out Media binding | What source supports | Still needed before release/cutover |
|---|---|---|---|
| Shared TypeScript UI | `libs/audio-video-ui/package.json`, `libs/audio-video-ui/src/foundations/index.ts`, `libs/audio-video-ui/src/index.tsx`; dependencies `@ghatana/design-system`, `@ghatana/theme`, `@ghatana/tokens` are `0.1.0-SNAPSHOT`. The sibling Shared packages declare the same versions and `private: false`. | Public package-shaped source exists and is consumed in the local workspace. `private: false` and matching source versions do not prove publication or immutable availability. | Published version+integrity digest, transitive license/SBOM, source-free packed consumer test, Shared owner acceptance, and accessibility/CSP qualification. |
| Tools/product-development TypeScript | `pnpm-workspace.yaml` includes sibling `../ghatana-tools/libs/product-development/*`; Media simulation uses `@ghatana/experience-package` `0.1.0-SNAPSHOT`. Tools `implementation-handoff`, `development-graph`, and `experience-package` source manifests are `0.1.0-SNAPSHOT`, `private: false`. | Local workspace API/source is discoverable. A sibling workspace link is not a release artifact. | Identify which packages are runtime/public dependencies versus development-only; pin only shipped public artifacts and test the installed consumer without sibling paths. |
| Lifecycle | Media's pnpm workspace includes sibling Lifecycle `libs/*` and `tools/*`. At inspected HEAD `556d6ef…`, `@ghatana/surface-convergence`, `@ghatana/documentation-model`, and `@ghatana/gtool` are `0.1.0-rc.1`, `private: false`, and `UNLICENSED`; package export maps and generic `ClosureGraph`/`PhaseProgram` source types exist. | These are checked-in workspace sources, not proof of published or source-free installed artifacts. No `SurfaceExperiencePack` or Media physical-to-semantic binding to multiple phase programs was found. The exact hierarchical Media contract remains `UPSTREAM_NOT_AVAILABLE`. | Recheck the exact public API, licensing/distribution authorization, and immutable artifact at the integration revision; consume only its declared contract. Do not copy graph/currentness/receipt logic. |
| Shared Java platform | `settings.gradle.kts` substitutes declared `com.ghatana.platform:*` dependencies with a sibling Shared composite build when present; Media modules reference Shared coordinates via `ghatana.shared.version`. | Build works against a local source composite by design; it does not establish isolated artifact consumption or exact artifact digest. | Resolve version catalog/property values and published immutable coordinates, verify licenses, then run source-free installed Gradle consumer tests. |
| Tools Java runtime | Media modules declare `com.ghatana.platform:tool-runtime` via `ghatana.tools.version`; `settings.gradle.kts` includes sibling Tools composite/source resolution. | Local public coordinate and source path are wired. No isolated published binding was qualified here. | Exact immutable version/digest and source-free consumer verification. |
| Kernel API | `modules/vision/vision-service` declares `com.ghatana.kernel:kernel-product-api`; `settings.gradle.kts` comments that the sibling Kernel product API uses coordinate version `0.1.0`. | A stable-looking version string is declared, but the local build can source-substitute through sibling Kernel settings. It is not proof that a released artifact is available or compatible. | Resolve publication provenance/integrity and licenses; verify package API and source-free consumer build. |
| Ghatana Platform / Data Cloud / AI Inference | Current Media build declarations inspected above show Shared and Tools platform coordinates and a Kernel API. The compatibility observation records Data Cloud read-model paths; no owner-approved direct AI Inference integration/version was identified in this scoped check. | Data Cloud is a compatibility/read-model consumer, not a license to transfer its generic metadata authority. Absence of a direct dependency declaration is not proof no runtime/network integration exists. | Owners must publish/accept the exact API and semantics; map HTTP acceptance, async effects, idempotency and event append independently. |
| Legacy Tools/product-development | `ghatana-tools` is a workspace dependency for definition tooling; the legacy identity and any consumer use must remain explicit in the contract inventory. | A workspace membership does not reveal every installed consumer or authorize renaming the public package/coordinate. | Identify every consuming package/route/build coordinate, preserve aliases through consumer migration, and obtain owner confirmation before deprecation. |

This review did not install or publish packages, inspect registry credentials, assert a successful source-free build, or change package versions. Do not infer license clearance from package manifests alone; release evidence must include the resolved transitive artifact set and owner policy.

## Read-only external issue state snapshot

Fetched the following GitHub issue records on 2026-10-12; all remained open at the observed state. This check made no comments or issue updates. An open issue is not an owner rejection, and a checked-in implementation is not package, independent-review, or Lifecycle acceptance.

| Boundary | Observed issue state | Remaining distinction |
|---|---|---|
| Media independent review | [ghatana-media #4](https://github.com/samujjwal/ghatana-media/issues/4) — open | Independent PDP semantic, visual, accessibility, and Explorer review remains required. |
| Shared UI/public tokens | [ghatana-shared #234](https://github.com/samujjwal/ghatana-shared/issues/234) — open | Exact public artifact identity and owner/a11y review remain pending. |
| Shared identity | [ghatana-shared #242](https://github.com/samujjwal/ghatana-shared/issues/242) — open | Trusted continuation and workspace-membership contract remains unbound. |
| Platform boundaries | [ghatana #254](https://github.com/samujjwal/ghatana/issues/254) — open | Data Cloud, Action Plane, and Event Plane owners have not accepted exact Media-facing semantics. |
| Lifecycle evidence provider | [ghatana-lifecycle #1](https://github.com/samujjwal/ghatana-lifecycle/issues/1) — open | Provider admission, artifact licensing/distribution, complete observers/oracles, and native Lifecycle receipts remain unresolved. |
| Tools dependency | [ghatana-tools #31](https://github.com/samujjwal/ghatana-tools/issues/31) — open | Its body identifies a completed development-source fix at `6ed2802`; package-owner compatibility/public binding and broader consumer limitations remain separate. |

## Consumer and contract inventory to close MIG-01

Re-run `migration/consumer-inventory.yaml` against named, owner-confirmed refs and append source evidence for every row below. Preserve separate states for route exposure, lifecycle authority, provider fulfillment, activation and downstream consumer finality.

| Consumer/boundary | Existing local evidence to reconcile | Before/after evidence required |
|---|---|---|
| Data Cloud media compatibility | `/api/v1/media` and `/api/v1/media/artifacts` are retained as non-authoritative compatibility/read-model surfaces in the migration records. | Enumerate exact method+path, DTO/error/status behavior and UI/navigation binding; prove compatibility adapter ownership and prohibit an accidental second lifecycle authority. |
| TutorPutor `TP-GHATANA-MEDIA-001` | Existing record lists 11 operations, accepted current contract, `UNFULFILLED` provider fulfillment and `SHADOW` activation. | Reconcile exact generated/public contract references and owner-approved provider+consumer proof; source move alone must not change fulfillment or activation. |
| Gharbatai Document Intelligence consumer | Existing record names a client path formerly under Media and a target service-owned client path. | Confirm current branch is release-relevant, source link has moved/rebound, and cancellation generation/qualification parity remains intact under MDI-001. No generic DI/OCR runtime is transferred to Media. |
| Shared Auth Gateway consumer path | Existing record identifies `libs/common` consumer path with Shared-owned authentication contract. | Confirm exact public path/version, trusted identity continuation and tenant/principal tuple with Shared; no locally invented authority. |
| PHR planned packages | Existing inventory finds package documentation references but no active source import in its bounded scan. | Named PHR owner confirms current intent, package names/subpaths and required publication/version; documentation is not counted as a bound runtime consumer. |
| Public HTTP, gRPC/protobuf, SDK and event consumers | `migration/contract-compatibility.yaml` names representative route families and supported SDK identity policy. | Generate method-by-method and RPC-by-RPC inventory from authored sources, compare DTOs, errors, field numbers, event IDs/append results and client exports. List absent and extra contracts explicitly; do not infer routes from family names. |
| Kernel, Tools, Toolchain, Lifecycle, Platform APIs | Current sibling workspace and build references are listed above. | For each actual caller, record owner, public artifact/version/digest, direct vs transitive use, license, consumer command/result and retirement/alias plan. |

## Owner-authorized transfer and rollback sequence for MIG-02/04

This is a proposed checklist, not permission to execute it.

1. **Freeze inputs.** Name the source owner and release/cutover owner; identify exact source and target commits/trees, owner-approved release branches, deployment/environment inventory, signed path disposition manifest, protected secrets/data exclusions and change window. Confirm the source subtree is unchanged since the approved inventory.
2. **Reconcile scope by path and owner.** Compare source inventory, target transfer receipt, path map and exception fingerprints. Preserve the MDI-001 split: generic Document Intelligence/OCR/parser execution remains Ghatana-owned; Shared generic processing remains Shared-owned; Data Cloud read-model authority and AI Inference model governance remain with their owners. Decide each generated contract/registry from its authored source.
3. **Prove contract parity.** Capture old/new exact HTTP method+path, request/response/error shape, protobuf package/service/field numbers, SDK package/subpath exports, event IDs/schema and persistence migration/checksum behavior. Run supported source and installed consumer checks. Any exception has a named consumer owner, compatibility adapter, expiry/revisit condition and rollback trigger.
4. **Prove reversibility before each wave.** Keep old source and aliases available. For each vertical workload record pre-switch traffic/health, immutable artifact/source identity, one-step binding switch, data/schema compatibility, backward-compatible rollback command and expected recovery signal. Exercise rollback in a non-production environment and record result before that wave is eligible.
5. **Admit, do not infer, cutover.** Obtain source-owner and affected-consumer-owner approvals plus required package/security/acceptance decisions. Record exact approval references and create the versioned cutover manifest. Only its admitted/executed evidence may change `BOUNDARY.md`'s canonical-source statement.
6. **Execute bounded waves.** Transfer only the approved paths; build and verify one vertical workload, switch one binding, observe agreed health/finality signals, and stop/rollback on failed invariants. Do not change unrelated consumer aliases or activate providers as an incidental result.
7. **Final authority handoff.** After all required consumers pass and old-source rollback remains available through the agreed observation window, record new canonical source, owner handover, deployments, data authority, outstanding exceptions and rollback expiry. Deprecate old paths only with owner approval and verified consumer removal. Archive immutable before/after evidence.

## Local preparation record

The initial canonical runtime implementation changed in source revision `688c948` for bounded RUN-02/03/04 work; follow-up work added OpenAPI assertions and handler-level reconciliation coverage. Subsequent local Media work added RUN-05/06/07 admission/contract slices and RUN-08 durable publication, all remaining uncommitted in the canonical checkout. This was runtime implementation work in the already-canonical source, not a repository transfer or cutover. No source move/transfer, package install/publication, owner contact, workflow activation, runtime/data handover, cutover rehearsal, or `BOUNDARY.md` authority change was performed for this task. `ghatana/services/media` remains the only editable runtime and semantic authority until an admitted manifest executes.

During target-checkout verification, the standalone Media version catalog's Testcontainers 2.0.5 RabbitMQ alias was found to use the old `org.testcontainers:rabbitmq` module name. It now points to `org.testcontainers:testcontainers-rabbitmq`, matching the current Ghatana root version catalog. This is a target build-metadata repair; it does not change runtime behavior or establish an isolated published-package build. The affected local Gradle module suites then completed with 631 tests, zero failures, and zero skips against the sibling source composites.

## MIG-02 exact-path candidate refresh — 2026-10-12

`migration/evidence/media-transfer-manifest-candidate-2026-10-12.json` is a deterministic, reversible-preparation artifact. It covers every exact source key in `migration/path-map.yaml` (2,811 rows) and the six additional source paths present in the refreshed MIG-01 committed-tree crosswalk but absent from that older path map, for 2,817 unique source paths total. It joins all 43 recorded transfer exceptions, preserves each mapped target disposition, carries exact source modes/blob IDs and target `HEAD` observations where available, and records source/target revisions and rollback references/triggers. Rows without a path-map disposition remain `UNRESOLVED_OWNER_REVIEW_REQUIRED`.

The latest refresh aligns the crosswalk and observed source `HEAD` at `65567dfff57d5ee9f5d7e8479dd311e5a7b6895d` on `codex/eni-v7-3-source-progress-2026-10-12`, and the target crosswalk and observed target `HEAD` at `81386992d273a98237451702c2daf618c77c8e51`. The verified source Media subtree tree remains `f73623d95f7951d7b265d1add23867c1df9a0a84`; commits added since the prior `7cfe8a1` crosswalk touch AEP only. The regenerated candidate records both current alignments explicitly. Current-tree observations exclude all uncommitted edits; this alignment freezes only the local committed-tree comparison and does not establish owner approval or cutover admission.

No path has a named individual owner or canonical generator identified in the reviewed source records, so those fields remain unresolved for every row. Database/data/secret ownership and rollback authority also remain unresolved. Transfer authorization and canonical-writer switch authorization are `NOT_AUTHORIZED` at the manifest and row levels; no source was moved, copied, deleted, or reclassified as noncanonical. The proposed rollback references and invariant/health triggers are planning fields only, not an executed rehearsal or delegated authority.

The owner decision still needs exact source and release/cutover owner identities, approvals from every affected consumer owner, owner-confirmed release branches and deployment/environment inventory, protected-secret/data exclusions, package/security/acceptance decisions as applicable, a signed change window, and a nonproduction rollback rehearsal with results. The current consumer inventory was captured 2026-10-04 and is a bounded local scan, not current owner confirmation. It identifies Gharbatai's Document Intelligence client/source link, TutorPutor `TP-GHATANA-MEDIA-001`, Data Cloud's governed Media metadata/read-model/API/UI, and the Shared Auth Gateway consumer path; PHR appears as documentation/design only. Obtain fresh evidence for those consumers and other supported HTTP/gRPC/protobuf, SDK, event, Tools, Toolchain, Lifecycle, Kernel, and Platform callers, with an owner disposition for each discovered route/RPC/export/event and any absent/extra contract. The bounded scan's no-direct-hit results for Tools, Yappc, and Kernel do not waive owner review.

Before cutover, reconcile the refreshed crosswalk with the actual source `HEAD`; freeze source/target revisions, release branches, exact environment inventory, signed per-path dispositions, named rollback authority, and change window; prove method/RPC/SDK/event/schema parity and consumer checks; exercise each rollback in nonproduction; obtain source-owner and affected-consumer-owner approvals; and admit a versioned cutover manifest. Until those gates are evidenced, keep source `services/media` canonical, preserve aliases and rollback availability, and do not switch writers, activate workflows, publish artifacts, or delete the source.

Validation: `node scripts/generate-media-transfer-manifest.mjs --check` is deterministic, and `node --test tests/media-transfer-manifest.test.mjs` checks complete unique path coverage, refreshed crosswalk identity, all 43 exceptions, proposed rollback evidence, and that unresolved owner/generator rows cannot become authorized. These checks validate local evidence shape only; they are not owner approvals or cutover qualification.
