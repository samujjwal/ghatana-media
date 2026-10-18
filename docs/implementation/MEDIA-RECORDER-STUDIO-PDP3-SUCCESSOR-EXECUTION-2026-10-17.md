# Media Recorder/Studio successor PDP-3 — implementation-ready Discovery worklist (2026-10-17)

**Source baseline:** merge of PR #10, `107b3324beca07644433ae0ca6fbbbc9cf82115c`. **Disposition:** successor P0–P2 source-authored only; historical PDP DEV_COMPLETE declarations are pinned to an older material source cut. The new `.product-experience/pdp-3-product-experience/recorder-studio-experience.yaml` is a source-owned PDP-3 **proposal**, not a new canonical requirement/operation/screen or runtime owner. Do not start Build, move Gharbatai source, certify a film, or declare PDP-0–3 DEV_COMPLETE from this change.

## Verified source inventory and boundary

- 4 logical children: recorder-orchestrator → CLI; capture-adapters → integrations; production-studio → web; interactive-demo-player → embedded. Existing physical candidate count 26, compositions 7 and historical consumers 17 are unchanged; 54×4=216 is the successor **proposed** population.
- PDP-0: 16 feature profiles / 84 canonical acceptance clauses; 462 existing capability leaves. PDP-1: 15 operation **proposals**, 52 manual edit discriminants. PDP-2: 16 group interface bindings, all 52 manual intents. PDP-3 successor: 16 profile flows / 84 step intents, 52 edit paths, 13 planned Studio workspace pages.
- Corrected a PDP-2 discrepancy: `surfaceInterfaces.production-studio.pages` had 11 pages while `productionStudioNavigation.workspace` had 13. Added `scene-storyboard` and `interactive-authoring` to make the two source views agree.
- No live checkout, installed dependency suite, CI, browser/API/CLI/provider run, exact source manifest regeneration, independently accepted screen, or 216-cell Lifecycle receipt was available for this remote authoring. The source checker and mutation tests are authored, **not executed**.

## Earliest affected phase first — only remaining tasks

| ID | Phase | Concrete work (where / how) | Required falsifiable outcome |
|---|---|---|---|
| REC-D0-01 | PDP-0 | On a full checkout run `corepack pnpm install --frozen-lockfile`, `pnpm check:recorder-studio-definition`, `pnpm test:recorder-studio-definition`; run parent/actor/capability/requirement/currentness and adverse-case mutation checks. Fix source defects rather than changing expected denominators. | Native strict YAML / semantic / negative tests green; current 84-case requirement meanings verified with source hashes. |
| REC-D0-02 | PDP-0 | Run `pnpm check:physical-topology`, `pnpm test:physical-topology` and material phase-cell/manifest generators with strict exact counts and logical child applicability. | 26 physical + 7 compositions + 17 old consumers preserved; 4 logical descendants not mistaken for executable packages; 200 historical cells not promoted to 216 completed. |
| REC-D0-03 | PDP-0 | Perform source-bound semantics and specialist/owner disposition for the impacted successor P0 cells; record decisions and source-current status under existing governance paths. | Zero remaining P0 definition tasks with actual accepted source-current result before advancing to P1. |
| REC-D1-01 | PDP-1 | Bind 15 proposed typed Recorder operations to existing `operations.yaml` owner semantics and 52 edit kinds to exact CAS, rights, timebase, output, idempotency, UNKNOWN/reconciliation and immutable revision read models; do **not** expose invented routes. | Every step's selected operation, effect class, version/precondition, outcome, failure and denial has exact owner binding or explicitly retained unresolved disposition. |
| REC-D1-02 | PDP-1 | Apply native `check:contract-parity` and domain/state/identity/provenance tests to changed source. Record qualified owner review. | No duplicate MediaProject, Job/Attempt, artifact store, policy owner or runtime writer; P1 successor source-current. |
| REC-D2-01 | PDP-2 | Reconcile both 13-page Studio workspace inventories, all 52 keyboard/text/CLI/SDK/API edit paths, source-time inspection, protected crop and no-fake-GUI semantics. Run `pnpm check:design-conformance` and `pnpm check:presentation-architecture`. | One semantic revision/action and accessible denial/UNKNOWN language across GUI/headless; P2 successor currentness established. |
| REC-D3-01 | PDP-3 | Complete exact step-level dispatch/recovery binding for all 84 proposed successor step intents in `recorder-studio-experience.yaml`. Reuse existing J-09/J-11/J-18–J-30 contract authority; do not add fictional top-level journey IDs. | Every step has a nominated admitted/explicitly non-applicable operation, action/observation, state, refusal, current version and safe recovery; no group-level candidate ambiguity remains. |
| REC-D3-02 | PDP-3 | Materialize the 13 Studio page contracts into `screen-contracts/`, screen/action/interaction registries, existing P2 template/layout/recipe/component bindings, with appropriate current source changes to canonical screen denominator. Capture adapter and CLI/API-only contracts must not create fake GUI. | Each GUI page has a complete design system chain, typed view/action state, keyboard/screen-reader, responsive and source-time grammar; every non-GUI operation has machine/text example. |
| REC-D3-03 | PDP-3 | Build typed fixture scenario matrix for each of 84 steps: positive, denied, conflict, UNKNOWN, source-unavailable, privacy, model abstain, license and offline cases where applicable. Bind journeys to actual channel/operation truth, not HTTP-success inference. | Real semantic outcome or truthful unavailable disposition per path, immutable source references and independent human approval gating. |
| REC-D3-04 | PDP-3 | Project new surface contract into `.product-experience/explorer/` from the same source IDs/screens/operations/fixtures. Run browser and CLI/API simulations; test keyboard, 16:9/9:16, reduced motion, source version, deny/reconcile, no fake UI. | Screens/pages and Explorer remain source-synchronized; fixture-only mode is labeled; live runtime coverage not inferred from projections. |
| REC-D3-05 | PDP-3 | Run `pnpm check:recorder-studio-experience`, `pnpm test:recorder-studio-experience`, PDP-3 local/phase strict tests, source-manifest/identity projections, `pnpm check:product-experience-local`, full currentness and independently authorized review. | Zero successor P3 authoring tasks, exact current-source PASS and 216-cell applicability truth; only then claim successor `DEV_COMPLETE`. |
| REC-DX-01 | Discovery exit | Run full cross-phase source-current/readmission and Lifecycle handoff, then freeze the implementation plan based on exact accepted P0–3 source. | Discovery exit proven for affected children, parents, compositions and root; Build authorized only after its independent entry criteria. |

## Source-only acceptance and manual/AI/privacy rules

Use the existing MediaProject immutable revision and original source/clock authority for both automated and manual modes. Product-owned fixtures, accounts, business effects, and tenant-specific policies remain with each product (Gharbatai first). No product action is demonstrated as successful without owner-readback after-action; camera/browser/etc only when qualified. Manual lock must survive regeneration; stale CAS/remote UNKNOWN cannot be force-resolved by GUI optimism. AI is native but policy-bounded, with provenance/uncertainty/abstention and no unapproved provider egress. Trace/metric/log records are redacted; rights, consent, legal holds, erasure, media quality and independently required film approval are distinct. Container, codec, voices, and model licenses remain provider-specific admission gates. A viewer hotspot is never a delegated privileged product mutation.

**This review records technical source dispositions only.** It does not forge a specialist certification, an accepted Discovery phase, or a production/provider proof.

## Source-only hygiene and negative-proof increment after PR #11

The 84 scoped PDP-3 steps no longer copy canonical `given/when/then/rejection` text or the same group operation candidates. The canonical clause reference is the single source of truth. Shared finality and non-admission rules are flow-level; 52 manual editing paths retain exact kind/typed intent/editor mapping while shared compare-and-swap, keyboard/text/CLI/SDK/API and undo/lock rules are declared once. The authored source shrank by 75,525 bytes (**56.8%**) with an unchanged 4/16/84/52/13 denominator.

All 13 planned Studio workspace pages now nominate `media.gui.template.*`, `media.gui.layout.*` and `media.gui.recipe.*` identities already defined in PDP-2. Bidirectional source comparisons found 13/13 mutually compatible design chains. These are **not** approved screen instances; there is still no admission of 13 new canonical PDP-3 screens and no Explorer runtime verification.

Checks authored: schema-strict YAML/duplicate rejection; P0/P1/P2 profile, typed group operation and 84 case identity comparison; 52 exact manual paths; 13 bidirectionally compatible GUI design chains; negative mutation of source semantics, false runtime admission, swapped parent/owner and incorrect template/layout. A restricted read-only parser and direct source readback returned zero mismatches, but that is **not** a repository-native test receipt. Required exact commands on full checkout, in order:

```bash
corepack pnpm install --frozen-lockfile
pnpm check:recorder-studio-definition
pnpm test:recorder-studio-definition
pnpm check:physical-topology
pnpm test:physical-topology
pnpm check:recorder-studio-experience
pnpm test:recorder-studio-experience
pnpm check:design-conformance
pnpm check:presentation-architecture
pnpm check:product-experience-local
```

Do not repin historical PDP status, present the source-only 84-step projection as dispatched product actions, or merge this change as Discovery phase exit. The next concrete P3 implementation-authoring work is exact screen/action/step-state/scenario/fixture and Explorer binding, then native verified readmission for affected cells.

## Required follow-up: canonical artifact registration and generated projections

**Verified source defect:** the four new Recorder/Studio P0–P3 authorities merged through PRs #10/#11 were not present in `.product-experience/artifact-identities.yaml`. Before this follow-up, the pinned identity registry listed **356** records while the repository contained four additional canonical Recorder/Studio phase sources. The manifest generator requires an exact one-to-one authored registry inventory and cannot safely derive these IDs from paths.

**Source correction:** four stable phase-appropriate identities are now pinned in the authoritative registry:

| Source | Stable artifact identity | Authority class |
|---|---|---|
| `pdp-0-product-truth/recorder-studio-extension.yaml` | `ART-P0-RECORDER-STUDIO-EXTENSION` | `PRODUCT_TRUTH_AUTHORITY` |
| `pdp-1-domain-data/recorder-studio-contracts.yaml` | `ART-P1-RECORDER-STUDIO-CONTRACTS` | `DOMAIN_DATA_AUTHORITY` |
| `pdp-2-design-interface-system/recorder-studio-interface.yaml` | `ART-P2-RECORDER-STUDIO-INTERFACE` | `DESIGN_INTERFACE_AUTHORITY` |
| `pdp-3-product-experience/recorder-studio-experience.yaml` | `ART-P3-RECORDER-STUDIO-EXPERIENCE` | `PRODUCT_EXPERIENCE_AUTHORITY` |

The registry now contains 360 unique paths and identities. The existing generated manifest has 356 artifact records and the Explorer index contains 357 including its manifest entry. Their missing four records and all source-content digest/dependency changes **must be generated**, not hand-edited. The source-based PDP-3 checker now rejects missing or misclassified Recorder/Studio identity records.

**Next native checkout actions:** run the focused Recorder/Studio and topology tests first; then run `pnpm generate:product-definition-manifest` (which owns both the source manifest and Explorer source index), inspect the generated diff for accidental unrelated changes and correct every dependency/identity finding, then rerun `pnpm check:product-definition-authority`, `pnpm check:product-experience-local`, focused PDP-3 tests and strict source-currentness. Do not mistake a generated manifest or hash receipt for semantic currentness, Lifecycle authorization, or PDP acceptance.

Native generation, real YAML/parser tests and end-to-end Explorer conformance remain **NOT_RUN** in this remotely authored increment.

## Cross-phase page parity and PDP-3 authoring continuation (post PR #13/#14/#15)

Source review identified **five design-reference differences across two pages** after concurrent PDP-2 and PDP-3 merges: storyboard was assigned a generic workbench instead of `media.gui.template.media-composition` / `media.gui.recipe.media-composition`, and delivery was assigned render-review rather than the PDP-2 `media.gui.template.task-setup` / `media.gui.layout.task-setup` / `media.gui.recipe.task-setup` chain. These five field references have been reconciled to the newer canonical PDP-2 page compositions. The PDP-3 checker now rejects a catalog-valid but wrong cross-phase mapping, and validates all 13 compositions' components, source case links, state grammar, headless and accessible behavior, and explicit non-admission. These checks are **authored** but not yet executed with native Node/YAML.

### Exact next PDP-3 tasks, after source-current PDP-0→1→2 validation

1. **12 existing-view specializations.** For each `productionStudioWorkspace.pages[].candidateCanonicalScreenRefs`, extend the relevant existing `pdp-3-product-experience/screen-contracts/*.yaml` view behavior without forking a second canonical screen. Bind exact owner view state, source time, typed P1 operation selection, mandatory preconditions, accessible keyboard/text/CLI/API equivalence, results, denial, and same-request UNKNOWN reconciliation. Source page proposals are not runtime support claims.
2. **One distinct interactive screen candidate.** Review `pdp3ScreenCandidates.records[0]` against P0 AC-050–053, P1 `interactive-graph`/`interactive-hotspot` values, PDP-2 `interactive-authoring` composition, and embedded viewer containment. If a new canonical screen is required, issue its accepted screen identity and contract, update the screen registry and physical/composition responsibility, then carefully recalculate the historical 47-screen denominator and any Explorer/source-current projections rather than silently recording 48 as completed. Keep branch navigation non-privileged and local; no business-effect proof from viewer clicks.
3. **Real fixture authoring.** Implement the six listed interactive tests (keyboard branch, forged hotspot, offline fallback, rejected HTML, telemetry consent denial, manual-lock revision conflict) as exact source-bound PDP-3 scenario records and representative payloads. Extend the existing scenario/step binding registries; do not create a competing Recorder fixture truth.
4. **84 exact step bindings.** Resolve each scoped step to an appropriate P1 typed operation (or explicit non-applicability), guard, observed owner result, effect finality and recovery. Candidate group operations alone do not satisfy this criterion. Preserve Gharbatai product-specific fixture/session/seed ownership outside Media.
5. **Explorer and source-manifest integration.** Regenerate, never manually patch, canonical `.product-experience/source-manifest.yaml` and `apps/media-experience-explorer/specification-artifacts.json` using `pnpm generate:product-definition-manifest` from a full checkout, then bind the accepted page/screen/step records to read-only and simulated Explorer modes. Verify no unadmitted action becomes executable.
6. **Native proof and acceptance.** Run `pnpm check:recorder-studio-definition`, `pnpm test:recorder-studio-definition`, `pnpm check:recorder-studio-experience`, `pnpm test:recorder-studio-experience`, `pnpm check:physical-topology`, `pnpm test:physical-topology`, design/presentation tests, `pnpm check:product-experience-local`, strict generated projections and source-current phase acceptance in sequence; record real evidence before setting successor PDP `DEV_COMPLETE`.

This authoring increment has a read-only source audit of 4 logical surfaces, 16 flows, 84 unique steps, 52 manual edit kinds, 13 design compositions, 12 existing-view reuse proposals and one unregistered interactive screen candidate. It is not a native test receipt or release/certification approval.
