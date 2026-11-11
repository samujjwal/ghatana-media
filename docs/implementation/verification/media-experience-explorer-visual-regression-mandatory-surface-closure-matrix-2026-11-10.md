# Media Experience Explorer Visual Regression — Mandatory Surface Closure Matrix

- Scope: local visual regression for the existing Media Experience Explorer browser audit only.
- Surface/build unit: apps/media-experience-explorer; browser audit entrypoint scripts/check-experience-browser.mjs.
- Inputs inspected: root AGENTS.md; app and surface READMEs; app package.json; Vite setup; index.html; src/main.ts; src/styles.css; existing browser tests and audit runner; docs/development/USABLE-SURFACE-DELIVERY.md; docs/EVIDENCE.md.
- User disposition: the eight captures in /tmp/media-experience-browser-audit were selected for local regression references. They are not accepted canonical design references. The source audit's independent visual-review and canonical-reference gates remain MANUAL_NOT_VERIFIED and NOT_SUPPLIED.
- Source capture report: the original report SHA-256 is c56d5fed19c3337cc7a924a38f9b1e9584e907d07d6b82064cacec02950c247f. It reports base URL http://127.0.0.1:4179/, Playwright 1.63.0 / Chromium 153.0.8010.12 on macOS ARM64 (provided by the user), desktop 1280×800 and narrow mobile 320×640 screenshots, no console/page errors or policy violations. All eight user-supplied screenshots initially matched a fresh pre-fix build byte-for-byte. The 320px Specification screenshot exposed a phase-badge text overlap; both Specification viewport references were corrected after the CSS fix. Original input captures and hashes remain stored separately in the local reference manifest.
- Review classification: a repeatable source-controlled pixel regression comparison is useful verification improvement, not a newly admitted Product route or a claim of full 47-screen host completion.
- Closure decision: the implementation below corrects the responsive phase selector, adds a real-browser assertion and pixel comparison, and retains both original user-selected captures and corrected local references with separate provenance hashes. It does not change task status, product authority, or lifecycle evidence.

## Mandatory surface area matrix

| Area | Status | Path-specific evidence and disposition |
| --- | --- | --- |
| prompt/repo guidance | reviewed-no-gap | AGENTS.md selects the usable-surface plan, local tests, and no formal evidence/status promotion. |
| recursive inventory | reviewed-no-gap | App source, tests, package scripts, Vite setup, docs, and the existing browser screenshot runner were inventoried; only local browser verification files are in scope. |
| surface kind/build unit | reviewed-no-gap | apps/media-experience-explorer/package.json defines the Vite/TypeScript app and Node test unit; Playwright 1.63.0 is already a development dependency. |
| ownership/boundary/placement | reviewed-no-gap | docs/surfaces/apps-media-experience-explorer/README.md assigns the browser client to Media and distinguishes the fixture Explorer from DEV_ONLY host routes and production authority. References/tests stay under the app's test tree. |
| vision/non-goals/consumers | reviewed-no-gap | App and surface READMEs define local review consumers and exclude human visual approval, provider qualification, production host, and lifecycle acceptance. |
| architecture/design | reviewed-no-gap | src/main.ts, src/styles.css, vite.config.mjs, and index.html define one Vite application and real hash-routed screens; screenshots are captured from the actual app through the existing browser audit. |
| documentation/examples | reviewed-no-gap | App README documents running the audit on preview port 4179; surface README documents consumer boundaries and commands. This change adds local reference provenance and the visual selector instructions. |
| requirements/current-state alignment | reviewed-no-gap | docs/development/USABLE-SURFACE-DELIVERY.md keeps media.dev.web-host OPEN for full host acceptance. The eight screenshots cover four existing views at two sizes and do not represent the 47-route completion claim. |
| gap/backlog classification | implemented | The visual comparator was a bounded local-verification improvement. DOM inspection found a current responsive overlap defect in the existing EXPLORER phase selector; its CSS root cause is fixed and exercised at 1280px and 320px. No Product capability or canonical visual gate is inferred. |
| feature completeness | reviewed-no-gap | Existing browser audit covers many source-defined views and the new comparison covers the eight captured states only; complete Product-host routes remain open. |
| correctness | implemented | At 320px, the EXPLORER badge's fixed 25px box let its 45px text overflow into the adjacent label. src/styles.css now gives the badge intrinsic width and a full row in the narrow two-column selector; scripts/check-experience-browser.mjs measures actual Range text bounds at 1280px and 320px. |
| API/contracts/config | reviewed-no-gap | No app runtime/API contract changes. A dedicated package script invokes the existing real-browser audit and local comparison. |
| generated/source-of-truth parity | reviewed-no-gap | References are retained test inputs with manifest hashes; they do not replace or rewrite .product-experience/, generated indexes, or Product source. |
| naming | reviewed-no-gap | Existing app/test naming and explicit visual-reference terminology keep regression reference distinct from canonical design approval. |
| duplication | reviewed-no-gap | Reuses the existing Playwright browser audit and screenshot scenario names; the comparator is a small PNG utility, not a second route simulator. |
| organization/placement | reviewed-no-gap | Browser snapshots and reference manifest are app test fixtures; the comparison script lives alongside the existing browser audit tooling. |
| cohesion/coupling | reviewed-no-gap | Comparator accepts paths and compares PNGs only; it has no dependency on app runtime state, API contracts, provider access, or outside authority. |
| tests/coverage | implemented | The real Playwright audit asserts non-overlapping phase text at desktop and 320px, then compares all eight screenshots in decoded pixel space. Comparator unit tests cover exact match, one-pixel mismatch, dimensions, malformed input, missing report arrays, incomplete names and manual-gate preservation. |
| compatibility/migration/deprecation | reviewed-no-gap | No published API, dependency resolution, route, persisted state, or package compatibility changes. |
| affected-scope verification | reviewed-no-gap | Focused command is the app's existing browser audit followed by local screenshot comparison; app package build/typecheck/test remain separately defined. |
| Evidence Generator integration | not-applicable | docs/EVIDENCE.md assigns canonical convergence receipts to Lifecycle and labels Media test output local-only. This app improvement is engineering verification, not a lifecycle evidence request. |
| missing Evidence Generator capabilities | not-applicable | No generator enhancement is required to compare a local browser rendering against local test references; no .evidence/** artifact is produced. |
| security | reviewed-no-gap | Existing browser runs against the app's local preview and strict CSP; this test adds no remote origin, credential, request, or mutable test service. |
| privacy/data governance/compliance | reviewed-no-gap | Captures contain synthetic, source-bundled Explorer content; no user media or credentials are captured. |
| observability/diagnostics | reviewed-no-gap | On mismatch the comparator reports case, dimensions, differing pixel count, exact-difference ratio, bounded sample coordinates, and emits a red/green difference PNG. |
| reliability/resilience/operability | reviewed-no-gap | Missing/malformed reference, report, or current screenshot fails closed; a preview server must be running at the documented loopback URL. |
| performance/scalability | reviewed-no-gap | Eight bounded full-viewport images are decoded and compared locally; no service load or production throughput claim applies. |
| accessibility/internationalization | implemented | The narrow Explorer phase label no longer overlaps its badge; browser geometry checks and corrected 320px screenshot verify the visible text arrangement. Existing keyboard, reduced-motion, forced-colors, focus and text-sizing checks remain; no screen-reader verification or RTL admission is claimed. |
| AI/ML applicability | not-applicable | The Explorer UI and deterministic browser screenshots do not invoke an AI/ML model. |
| build/dependency/release readiness | reviewed-no-gap | Playwright is already declared in apps/media-experience-explorer/package.json; no new package dependency or release artifact is introduced. |
| dependency/supply-chain/licensing | reviewed-no-gap | Existing Playwright version is reused; PNG comparison uses runtime built-ins only. |
| repeatability/reproducibility | implemented | Owner reports two audit runs had identical image hashes. The committed manifest pins those local input hashes; the visual command compares decoded pixels and fails on any changed pixel. |
| convergence/stability | reviewed-no-gap | This local regression output does not score or claim convergence; full product-host and independent design review gates remain open. |

## Findings and acceptance

### F1 — Browser screenshots were not compared to retained local references

- Location: scripts/check-experience-browser.mjs, apps/media-experience-explorer/test/, and app README.
- Root cause: the audit emitted review screenshots and instructed repeat runs to have stable hashes, but no source-controlled baseline/comparison command existed.
- Classification: bounded local verification improvement; it does not represent canonical design acceptance. The user selected these captures for local regression.
- Production-ready fix: retain exact original user-supplied PNGs and hashes; pin corrected active PNGs separately; compare real current-browser route screenshots to active references in decoded pixel space; report actionable diffs without silently accepting changed images.
- Acceptance: all eight original screenshot digests remain represented; the focused command runs the current real-browser audit; decoded dimensions and RGBA pixels match the corrected baseline; a one-pixel mutation produces a non-zero result and a diff PNG; app docs explain reference updates require explicit review.
- Path-scoped tests: app browser audit and the comparator's deterministic mutation/format tests.
- Path-scoped evidence: command output and comparison diff artifacts under the local temp audit directory. This is not a Lifecycle Evidence Generator receipt.
- Convergence impact: none; this is not full host convergence or design approval.

### F3 — Explorer phase badge text overlapped its label at narrow width

- Location: apps/media-experience-explorer/src/styles.css, .phase-tab and the EXPLORER data-phase badge; scripts/check-experience-browser.mjs Specification viewport capture.
- Root cause: the badge had a fixed 25px width, while the unbroken EXPLORER word required 45.19px. The button grid allocated a 27px first column, so the badge text overflowed into the Experience Explorer label. The viewport sweep did not measure text bounds.
- Classification: current-state responsive UI correctness gap on an existing source-defined phase-selection control.
- Production-ready fix: use an intrinsic-width badge/column and let the EXPLORER row span both narrow-screen columns.
- Acceptance: actual text Range bounds stay left of the label, and label stays inside the tab at 1280px and 320px; the existing 31-scenario/47-route browser audit has no failures; regenerated desktop and narrow-mobile Specification screenshots show the corrected layout.
- Path-scoped tests: scripts/check-experience-browser.mjs includes DOM-bound assertions at 1280px and 320px; the visual-regression command checks all active screenshots; comparator unit suite validates pixel mismatch behavior.
- Path-scoped evidence: Chromium before-fix measurement recorded a 25px badge box and 45.19px text; after-fix measurements at 320/390/1280px show badge text ending at x=72.19 and label beginning x=86.19 at mobile widths, with no horizontal document overflow. The original user capture hashes and corrected active hashes are separately pinned.
- Convergence impact: the local responsive defect is repaired. Canonical visual design, full 47-screen host, independent review and task acceptance remain open.

### F2 — Visual authority gates remain separate

- Location: supplied report.json, fields manualGates.independentVisualReview and manualGates.canonicalVisualReferences.
- Root cause: no design-owner canonical visual references or independent expert visual review were included in the audit.
- Classification: externally owned review boundary, not a pixel comparator defect. The user selected these captures for local regression only.
- Disposition: preserve the manual-gate statements and label stored images as local regression references; do not change media.dev.web-host status.
- Acceptance: final report retains the truthful gate wording and docs state the limits. No local command can satisfy this human/owner review.
- Path-scoped evidence: stored source audit report plus app/surface README wording.
- Convergence impact: the eight local references cannot be used as canonical product design approval.

## Current-source verification — 2026-11-10

`pnpm --filter @ghatana/media-experience-explorer test:visual-regression` passed: the browser audit covered 31 scenarios, 47 Product routes, and 376 specification records with zero failures, console/page errors, or policy violations; all 8 approved local reference screenshots matched exactly (0 differing pixels). The report preserves `screenReader=MANUAL_NOT_VERIFIED`, `independentVisualReview=MANUAL_NOT_VERIFIED`, and `canonicalVisualReferences=NOT_SUPPLIED`. This confirms local regression only and does not close `media.dev.web-host`. Result JSON: `/var/folders/ct/rbzll5l91xj9hw30s3j768yc0000gn/T/media-experience-visual-regression.boqkPu/report.json`.
