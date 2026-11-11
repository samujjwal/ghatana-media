# Media pnpm Source-Composite Manifest — Mandatory Surface Closure Matrix (2026-11-10)

Scope: Media root pnpm workspace manifest resolution for Lifecycle packages included by `pnpm-workspace.yaml`, especially `../ghatana-lifecycle/libs/evidence-contracts`. This is a source-composite install correctness review, not a lifecycle status or release review.

## Mandatory Surface Closure Matrix

| Area | Status | Evidence inspected/artifact | Findings | Action |
|---|---|---|---|---|
| prompt/repo guidance | reviewed-no-gap | `AGENTS.md`; scoped audit handoff `/tmp/media-pnpm-workspace-manifest-audit.md` | Source-composite engineering is allowed; no task, admission, PDP, or release status may be changed. | Keep the change in Media and retain the status boundary. |
| recursive inventory | implemented | `pnpm-workspace.yaml:14-15`; root `.pnpmfile.cjs`; Lifecycle package YAML/JSON; Tools workspace package manifests | Media includes Lifecycle `libs/*` and `tools/*`; currently included Tools product-development packages have `package.json` but no temp `package.yaml` projections. | Dispatch the Lifecycle projection only; keep Tools projection dispatch out of current scope. |
| surface kind/build unit | reviewed-no-gap | root `package.json` (`pnpm@10.33.0`); `pnpm-workspace.yaml`; `pnpm-lock.yaml` | Shared lockfile and root pnpm hook are the resolution unit. | Run pinned pnpm commands from Media root. |
| ownership/boundary/placement | implemented | root `.pnpmfile.cjs`; `../ghatana-lifecycle/.pnpmfile.cjs` | Media delegates to the Lifecycle-owned hook; sibling files/manifests remain untouched. | Preserve owner hook path containment behavior. |
| vision/non-goals/consumers | reviewed-no-gap | `README.md`; `docs/README.md`; `BOUNDARY.md` | The root workspace is a local source-composite consumer; this does not admit/publish sibling artifacts. | No product-semantic change. |
| architecture/design | implemented | root `.pnpmfile.cjs`; Lifecycle `.pnpmfile.cjs`; regression test | Dispatch is limited to `kind: package`, the exact temporary layout standard, and exact Lifecycle `repositoryRef`. | Continue reusing the owner algorithm. |
| documentation/examples | implemented | `docs/development/PNPM-SOURCE-COMPOSITE-MANIFEST-AUTHORITY.md`; `docs/README.md` | Manifest authority and focused commands are now documented. | Keep root docs linked from the documentation index. |
| requirements/current-state alignment | implemented | Lifecycle canonical package manifests and owner hook; staged source-composite lock; current Media `pnpm-lock.yaml` | All 61 named package manifests plus the Media root were represented in the staged importer list; the generated lock passes frozen offline validation in both the staged tree and Media root. | Keep dependency truth in owning manifests and retain the 62/80 scope diagnostic. |
| gap/backlog classification | reviewed-no-gap | reproducible frozen error; focused design | Current-state install correctness gap, not an optional feature. | Keep correction scoped to manifest resolution and lock. |
| feature completeness | implemented | root hook; `tests/pnpm-workspace-manifest-hook.test.mjs` (3/3 pass) | Lifecycle owner dispatch, unrelated pass-through, and non-included Tools projection pass-through are covered. | Keep dispatch narrow as workspace membership changes. |
| correctness | implemented | Generated lock candidate; root and staged frozen offline outputs; preimage/postimage SHA-256 | Frozen offline validation now exits 0 from both the physical-sibling staging tree and actual Media root. No package installation or sibling mutation occurred. | Rerun the lock-only frozen check after workspace manifest, hook, or membership changes. |
| API/contracts/config | implemented | root `.pnpmfile.cjs`; root `pnpm-workspace.yaml` | No public runtime API changes; pnpm hook is the root config surface. | Fail clearly when a recognized Lifecycle projection lacks its owner hook. |
| generated/source-of-truth parity | implemented | Lifecycle/Shared/Tools source manifests; `.pnpmfile.cjs` owner dispatch; generated `pnpm-lock.yaml`; `tests/pnpm-workspace-manifest-hook.test.mjs` | The generated lock contains 62 importer entries matching the staged workspace list. The source-consistent update includes canonical Lifecycle dependency/devDependency projections and current package graph resolutions. | Preserve pnpm-native generation; never hand-edit importer projections. |
| naming | reviewed-no-gap | `.pnpmfile.cjs`; regression file/test names | Names state source-composite manifest authority and owner hook behavior. | No naming changes required. |
| duplication | implemented | Media root hook and both owner hooks | Media delegates; it does not copy the sibling hook algorithms. | Do not duplicate owner package traversal. |
| organization/placement | implemented | root `.pnpmfile.cjs`; `tests/pnpm-workspace-manifest-hook.test.mjs`; docs under `docs/development/` | Hook is beside root lock/workspace files; test and explanation have scoped locations. | Keep hook at workspace root. |
| cohesion/coupling | implemented | `.pnpmfile.cjs` repositoryRef map | Only Lifecycle's exact owner ref is dispatched; unknown owners return unchanged. | Add another owner only after its packages are included and its owner hook exists. |
| tests/coverage | implemented | `node --test tests/pnpm-workspace-manifest-hook.test.mjs` | Three tests pass: actual Lifecycle dependency/devDependency parity, ordinary manifest identity pass-through, and non-included Tools projection pass-through. | Keep focused regression in the standard Node test format. |
| compatibility/migration/deprecation | reviewed-no-gap | package manifests and lock configuration | No package API/version migration; only root manifest interpretation and lock consistency. | No migration required. |
| affected-scope verification | implemented | `node --test tests/pnpm-workspace-manifest-hook.test.mjs`; staged and root frozen offline commands | Hook tests pass 3/3; the regenerated lock passes the exact frozen command in the isolated physical-sibling tree and actual Media workspace. | Keep this two-layout verification on future source-composite lock refreshes. |
| Evidence Generator integration | not-applicable | `AGENTS.md`; package-manager scope | This install consistency repair is ordinary deterministic engineering evidence, not a product Evidence Generator surface. | No Evidence Generator artifact is required. |
| missing Evidence Generator capabilities | not-applicable | same scope and evidence plan | No product evidence collector or schema is needed for a pnpm importer check. | No enhancement task. |
| security | reviewed-no-gap | owner Lifecycle `.pnpmfile.cjs` path guards; Media exact owner path dispatch | Media reuses owner validation and never parses arbitrary source refs itself. | Preserve the Lifecycle hook's containment guards. |
| privacy/data governance/compliance | not-applicable | install metadata and local package manifests only | No media/user data is read or processed. | No data controls apply. |
| observability/diagnostics | implemented | explicit missing-hook and invalid-hook errors in root `.pnpmfile.cjs` | A recognized Lifecycle projection cannot silently proceed if its owner hook is missing. | Keep errors actionable and owner-specific. |
| reliability/resilience/operability | implemented | hook load guards; focused test | Owner hook absence fails closed; unrelated packages pass unchanged. | Frozen lock validation remains the operational check. |
| performance/scalability | not-applicable | one local owner-hook dispatch per eligible package | The hook adds bounded local module loading; no runtime service path changes. | No performance benchmark needed. |
| accessibility/internationalization | not-applicable | no user interface or localized behavior | No accessible UI surface is changed. | None. |
| AI/ML applicability | not-applicable | deterministic package-manager configuration | No model inference is useful for manifest resolution. | Keep deterministic. |
| build/dependency/release readiness | implemented | Pinned `pnpm@10.33.0`; regenerated `pnpm-lock.yaml`; frozen offline outputs | Local source-composite dependency consistency is verified. This is not package publication, release qualification, or sibling artifact admission. | Keep the status boundary explicit. |
| dependency/supply-chain/licensing | reviewed-no-gap | root hook references local sibling Lifecycle hook only | No new external package or dependency source is introduced. | No lock package addition is intended from this fix. |
| repeatability/reproducibility | implemented | `/tmp/media-pnpm-full-composite.Z4OPhj/pnpm-lock.preimage.yaml`; generated lock; staged/root frozen offline outputs | Lock generation used pnpm itself over the staged current manifests/hooks. Preimage and postimage hashes and importer/package counts are recorded below; frozen replays pass. | Rebuild the staging tree from current sources if any workspace input changes. |
| convergence/stability | reviewed-no-gap | This matrix; exact 62-entry staged list; Media lock; frozen offline output | The lock matches the 62 entries reported by the recursive list and contains no importer drift. pnpm's `Scope: 62 of 80 workspace projects` denominator remains unexplained, but no missing importer is evidenced by the staged workspace list. | Retain the 62/80 diagnostic and revisit if pnpm inventory or lock importer counts diverge. |

## Finding KPM-01 — stale canonical workspace importers (resolved locally)

- **Priority:** P1
- **Area:** Correctness; generated/source-of-truth parity; affected-scope verification; build/dependency/release readiness; repeatability/reproducibility; convergence/stability.
- **Where:** Media `pnpm-lock.yaml` importers for `../ghatana-lifecycle/libs/cli-contracts` and other Lifecycle workspace projects.
- **Problem:** The owner hook now exposes canonical Lifecycle `package.json` dependency maps, while the dirty Media lock still records older importer specs. The focused initial frozen failure named `evidence-contracts`; after hook activation, the current frozen check first reports `cli-contracts` missing `@ghatana/tool-platform-contracts@workspace:*`.
- **Root cause:** The pre-existing Media lock was not synchronized with the current canonical sibling npm manifests. The first non-frozen offline refresh returned 0 but added only the root `pnpmfileChecksum`; repeating with `--force --no-frozen-lockfile` also left importer rows unchanged.
- **Classification:** Current-state correctness gap.
- **Production-ready fix:** Use a pnpm-native offline lock refresh that rewrites the source-composite importers from the owner-hook results. Do not hand-edit dependency rows or change sibling files/manifests.
- **Acceptance criteria:** `pnpm install --lockfile-only --frozen-lockfile --offline --ignore-scripts` exits 0; lock delta against the saved preimage consists only of source-consistent importer/catalog/package resolution changes; `git diff --check` passes.
- **Path-scoped tests required:** `node --test tests/pnpm-workspace-manifest-hook.test.mjs`; frozen offline check above.
- **Path-scoped evidence required:** exact diff against `/tmp/media-pnpm-lock-before-manifest-hook-20261110.yaml`; frozen output; `git diff --check`.
- **Evidence Generator enhancement:** None; repo-native package manager and Node test outputs are sufficient.
- **Convergence impact:** Resolved for the current local source-composite workspace on 2026-11-10; the regenerated lock and frozen validation pass. The unexplained `62 of 80` console denominator remains a diagnostic to revisit if the workspace list and importer counts diverge.

### Resolution disposition (2026-11-10)

KPM-01 is resolved for the current Media source-composite workspace. Offline refresh attempts first stopped before writing because the package cache lacked `jotai` registry metadata. The lock was then regenerated with pnpm 10.33.0 in an isolated staging tree containing the exact current workspace manifests and owner hooks in physical sibling directories. The generated postimage was reviewed and replayed with the frozen offline command before adoption. It preserves 62 importers, changes 45 current source importer records, updates the package map from 330 to 345 entries and snapshots from 336 to 345, and all external package resolutions carry integrity metadata. No sibling manifest, source tree, or `node_modules` changed.

The 62 importer paths match the staged recursive package list (61 named workspace packages plus Media root). pnpm still prints `Scope: 62 of 80 workspace projects`; that denominator has not been explained. It remains a diagnostic, not evidence of an omitted lock importer, because `pnpm -r list --depth -1 --json`, the staged inventory, and lock all report the same 62 entries.

## Verification record

- Focused test: PASS, 3 tests.
- Staged pnpm-native refresh: `pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile`, exit 0 after package metadata was available; run only in `/tmp/media-pnpm-full-composite.Z4OPhj/workspace/ghatana-media`.
- Staged frozen replay: `pnpm install --lockfile-only --frozen-lockfile --offline --ignore-scripts`, exit 0 with pnpm 10.33.0.
- Media root frozen replay: `pnpm install --lockfile-only --frozen-lockfile --offline --ignore-scripts`, exit 0 with pnpm 10.33.0.
- Focused hook test: `node --test tests/pnpm-workspace-manifest-hook.test.mjs`, 3/3 pass.
- Lock hashes: preimage `a7d9860f96e051fbf85969ec91031a517e288b3eff8ef86bbf9a2b885fd3cebf`; generated postimage `0cbfe653a3fcf41fc71379ae3d315fdb2f5d269aaeda1f2404baa1ab019c61bb`.
- Two earlier offline no-frozen refresh attempts failed before writing with `ERR_PNPM_NO_OFFLINE_META` for `jotai`; their lock stayed byte-identical. This historical failure is retained rather than conflated with the later successful postimage.
- Tools temp-projection dispatch: not applicable to the current Media workspace; no included Tools workspace project contains a temporary `package.yaml` projection. The regression asserts a Tools projection outside current membership passes through unchanged.
- No lifecycle status, task/admission decision, PDP status, release status, sibling repository file, or `node_modules` tree was changed.
