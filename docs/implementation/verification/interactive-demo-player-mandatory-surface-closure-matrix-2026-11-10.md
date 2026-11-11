# Interactive demo player — Mandatory Surface Closure Matrix

## Scope

This is a path-scoped engineering review of `libs/audio-video-ui/src/player`
for OPEN task `media.dev.interactive-demo-player`. The source selector is
`docs/development/USABLE-SURFACE-DELIVERY.md` and the canonical task definition
remains in `docs/development/remaining-work.json`. This matrix is not PDP
acceptance, host qualification, lifecycle closure, or release evidence.

The source definition is now documented at `libs/audio-video-ui/README.md`,
`libs/audio-video-ui/src/player/README.md`, and
`docs/surfaces/surface-interactive-demo-player/README.md`. The bounded commands
and expected evidence are in
`interactive-demo-player-evidence-plan-2026-11-10.md`.

## Mandatory Surface Closure Matrix

| Area | Status | Evidence inspected/artifact | Findings | Action |
|---|---|---|---|---|
| Prompt/repo guidance | reviewed-no-gap | `AGENTS.md` selects the usable-surface plan and keeps task status in `remaining-work.json`; `libs/audio-video-ui/README.md` defines package change policy; no nested `AGENTS.md` exists under the package. | Backend-first lane is allowed; no player-specific override or lifecycle promotion applies. | Preserve the selected task and explicit host boundary. |
| Recursive inventory | reviewed-no-gap | `libs/audio-video-ui/src/player/{README.md,index.ts,interactiveDemoPlayer.tsx,interactiveDemoState.ts,interactiveDemoPlayer.test.ts}` and `libs/audio-video-ui/test/interactive-demo-player/{index.html,fixture.tsx,browser.test.mjs,tsconfig.json}`. | React view, reducer, unit tests, and bounded browser fixture have separate roles. | Keep changes within this inventory. |
| Surface kind/build unit | reviewed-no-gap | `libs/audio-video-ui/package.json`; pnpm package `@audio-video/ui`; Vitest, TypeScript and Vite browser selector. | Reusable TypeScript React library, not a deployed product. | Verify the affected package and browser fixture. |
| Ownership/boundary/placement | reviewed-no-gap | PDP-2 `recorder-studio-interface.yaml#surfaceInterfaces/media.surface.interactive-demo-player`; package ports/export map; player README. | UI consumes host attestation and never owns signature verification, identity, rights, or product mutations. | Keep the transcript presentation-only. |
| Vision/non-goals/consumers | reviewed-no-gap | `libs/audio-video-ui/README.md` and `docs/surfaces/libs-audio-video-ui/README.md`. | Host UI is the purpose; deployed runtime and provider effects are explicit non-goals. | Retain those limits in user-visible source-truth states. |
| Architecture/design | reviewed-no-gap | `interactiveDemoPlayer.tsx`, `interactiveDemoState.ts`, shared design-system dependencies and PDP-2 interface. | Native media, reducer state, host verification port, and origin permissions are distinct; visual styling uses shared tokens. | Add transcript as a view of existing cue data, not a new state owner. |
| Documentation/examples | reviewed-no-gap | Package and player READMEs; `examples/media-creative-preview`; local WAV generation and browser commands. | Local fixture path and production limitations are recorded. | Update local evidence wording after tests. |
| Requirements/current-state alignment | implemented | PDP-2 transcript requirement; PDP-3 text-alternative/transcript requirement; `interactiveDemoPlayer.tsx` now renders each exact active-scene cue with its millisecond start. | The complete authored caption transcript was absent; independent review confirmed that a projection of already-bound cues is source-defined. | Keep transcript presentation-only; no manifest field or host authority added. |
| Gap/backlog classification | reviewed-no-gap | Task readiness/acceptance in `remaining-work.json`; PDP-2/PDP-3 source refs; existing tests. | Transcript absence is a current-state gap. A new manifest description field is blocked by contract ownership; certification and hosted behavior are not local backlog code. | Fix the derived transcript; keep task OPEN for unbound source meaning and host gates. |
| Feature completeness | implemented | `interactiveDemoPlayer.tsx` transcript disclosure; focused player tests and pinned browser test. | The locally derivable transcript now appears in stable chronological order and follows exact branch scene state; the non-verbal visual alternative remains a distinct owner gap. | Treat only the caption transcript as complete locally; do not infer descriptions. |
| Correctness | reviewed-no-gap | `interactiveDemoState.ts` validates exact scene, asset revision, caption asset version, cue IDs, origins and branch reachability; reducer tests cover boundaries and replay. | Transcript must consume only the active scene after its manifest passed these checks. | Reuse validated `activeScene`; add stale/empty/branch regression. |
| API/contracts/config | reviewed-no-gap | `DemoScene`, `DemoCue`, manifest validator and `package.json#exports`. | Existing cue text and integer-millisecond bounds are sufficient for caption transcript; no public manifest addition is needed. | Add no API, dependency, configuration, or route. |
| Generated/source-of-truth parity | implemented | PDP-2 interface and explicit package export map; `pnpm refresh:executable-representation-observations` refreshed 12 exports/158 source observations; product manifest regenerated to 375 records/376 Explorer records; experience candidate schema-valid/public-validator PASS. | The transcript changes no API or source contract; generated source hashes and local projections were refreshed after implementation. | Keep exports and authored product meaning unchanged; retain candidate as unaccepted and not current. |
| Naming | reviewed-no-gap | Existing `InteractiveDemoPlayer`, `DemoScene`, `DemoCue`, `captions` and `transcript` source terms. | No competing state or naming family is required. | Use `Transcript` as the disclosure label and existing cue terminology. |
| Duplication | reviewed-no-gap | `demoCaptionAt` and cue data in `interactiveDemoState.ts`; `TranscriptCaptionScreen` is a different product workflow. | Transcript is a read-only projection of existing cues, not a second caption store. | Share cue objects; do not duplicate or mutate them. |
| Organization/placement | reviewed-no-gap | `src/player/` separates embedded player state/view; new module README states intent. | The transcript belongs in player view and its tests, not a new screen or domain contract. | Keep UI-only files in the player module. |
| Cohesion/coupling | reviewed-no-gap | Player imports reducer/model helpers and React only; package entry points remain explicit. | Presentation stays cohesive and does not couple to network or provider APIs. | Keep transcript formatting local to view. |
| Tests/coverage | implemented | Player Vitest `interactiveDemoPlayer.test.ts` 24/24; full package check 181/181 across 16 files; pinned loopback Playwright selector 5/5, zero skips/failures/errors. | Tests now cover exact cue order/times, tied timestamps, branch replacement, empty transcript, denial/stale suppression, and keyboard disclosure in browser. | Retain local-only interpretation; screen-reader qualification remains unclaimed. |
| Compatibility/migration/deprecation | reviewed-no-gap | Package 0.1.0-SNAPSHOT export map and manifest shape. | Additive rendered content leaves the exported TypeScript contract unchanged. | Preserve markup roles and existing controls; no migration. |
| Affected-scope verification | reviewed-no-gap | Evidence plan lists Vitest, package check/build, loopback browser, surface docs, design conformance and diff checks. | React rendering changes need package/browser evidence; Java and unrelated workspace suites do not. | Run the listed selectors and report external gates separately. |
| Evidence Generator integration | not-applicable | `AGENTS.md` explicitly excludes formal evidence/closure from this feature lane; local package selectors and task progress are the authorized engineering record. | No Evidence Generator artifact is used to make lifecycle or convergence claims. | Keep local results in task progress; do not create `.evidence` or closure status. |
| Missing Evidence Generator capabilities | not-applicable | The plan requires no formal Evidence Generator output and forbids treating helper checks as convergence truth. | Screen-reader certification and production host admission require external authority, not a collector repair in this UI increment. | Record the limit; do not create a new task universe or fake artifact. |
| Security | reviewed-no-gap | `interactiveDemoState.ts#validateManifest`; `interactiveDemoPlayer.tsx` exact host verification, anonymous CORS, no script injection; cross-origin browser denial tests. | Transcript rendering uses escaped React text from already validated, integrity-bound caption data. | Do not use `dangerouslySetInnerHTML`, fetch, or delegate effects. |
| Privacy/data governance/compliance | reviewed-no-gap | `DemoCue` is authored text; current view has no analytics or persistence; PDP source requires consent/minimal analytics. | The transcript duplicates no data beyond the current manifest and does not persist or transmit it. Rights remain host-owned. | Keep text local and avoid analytics changes. |
| Observability/diagnostics | reviewed-no-gap | Player `role=status` live region announces state and failures; `DemoPlayerFailure` is typed; README documents troubleshooting boundary. | A transcript is content, not a new diagnostic signal. | Preserve typed refusal/status output. |
| Reliability/resilience/operability | reviewed-no-gap | `interactiveDemoState.ts` denies unavailable/mismatched verification, invalid origins and stale asset/caption; media event handlers guard detached elements. | Transcript follows the validated active scene and cannot keep stale content after a branch. | Test branch switch and denied/stale states. |
| Performance/scalability | reviewed-no-gap | Player tests use a deterministic 2 s WAV; transcript ordering is memoized by active scene and no media bytes are copied by React. | The owner source defines no maximum cue count/manifest size, so the local suite does not claim large-manifest performance. | Preserve local behavior; set bundle limits only with host-owned source and profile. |
| Accessibility/internationalization | blocked | PDP-2 transcript/accessible-alternative components; PDP-3 text alternative/transcript; keyboard browser selector; player-specific source contract review. | The authored cue transcript is implemented. The manifest has no distinct visual-description source, and DOM/browser assertions are not human screen-reader qualification. | Preserve the transcript fix; do not infer a visual alternative. Obtain owner-defined source binding and screen-reader qualification before claiming full accessibility completion. |
| AI/ML applicability | not-applicable | Player uses authored scenes and deterministic reducer; no inference or model dependency appears in its API/build. | AI/ML would not improve transcript fidelity here. | Keep rendering deterministic and source-bound. |
| Build/dependency/release readiness | reviewed-no-gap | `package.json` explicit exports and scripts; pnpm lock pins React/Vitest/TypeScript/Playwright; no dependency change planned. | Local package build is sufficient for this source-only UI change. | Run typecheck/build; make no release claim. |
| Dependency/supply-chain/licensing | reviewed-no-gap | Workspace dependency declarations and pinned lockfile; player adds no dependency or remote installation. | No supply-chain surface changes. | Confirm lockfile unchanged. |
| Repeatability/reproducibility | reviewed-no-gap | Fixed synthetic WAV digest in logical player README; pinned Playwright 1.63.0 and Chromium 153.0.8010.12; deterministic cue state tests. | Browser evidence can repeat against the same fixture and toolchain. | Record exact test counts and confirm repeated stable fixture use. |
| Convergence/stability | blocked | `remaining-work.json` task `media.dev.interactive-demo-player`; updated task progress; local check outputs in the evidence plan. | Local transcript gap is closed, but the complete task still needs owner-defined visual alternative, host verification, rights, canonical project/artifact binding, and screen-reader qualification. | Keep task OPEN; continue independent local work without converting these gates to status. |

## Findings

### PDP-TRANSCRIPT-001 — P1, implemented current-state gap

- **Area/location:** requirements, feature completeness, tests and accessibility;
  `libs/audio-video-ui/src/player/interactiveDemoPlayer.tsx`.
- **Root cause:** no view projected the full `activeScene.captions.cues` list.
- **Production-ready local fix:** added a native keyboard disclosure rendering
  exact cue text in stable chronological order, exact millisecond start, and the
  cue language. It uses React text nodes and adds no fetch, field, export, or
  state authority.
- **Acceptance:** all cues appear once, tied times preserve authored order,
  branch selection replaces the transcript, empty cues report absence, and
  denied/stale scenes expose no transcript.
- **Path tests:** focused player Vitest PASS 24/24; full UI package check PASS
  (typecheck, 181/181 tests, build); pinned loopback browser PASS 5/5 with zero
  skips/failures/errors.
- **Path evidence:** command/result and source-fingerprint plan in
  `interactive-demo-player-evidence-plan-2026-11-10.md`; updated task-local
  progress in `USABLE-SURFACE-DELIVERY.md`.
- **Evidence Generator enhancement:** none for this local behavior; no formal
  Evidence Generator output is authorized for this feature lane.
- **Convergence impact:** the local caption-transcript gap is implemented;
  player and journey statuses remain OPEN.

### PDP-ALTERNATIVE-001 — P1, blocked on owner-defined source semantics

- **Area/location:** PDP-2 `recorder-studio-interface.yaml:28-33` and PDP-3
  `recorder-studio-experience.yaml:1628-1632`; `DemoScene` currently carries
  label and caption cues but no authored visual-description field.
- **Root cause:** the interface source requires an accessible alternative
  without defining a version-bound value in the existing manifest contract.
- **Production-ready fix:** owner source must define whether a scene-level
  alternative is authored text, transcript/caption sufficiency, or another
  typed representation and how its bytes bind to the signed manifest.
- **Acceptance:** source-bound alternative is exposed to assistive technology,
  stale/missing descriptions fail truthfully, and no text is inferred from
  pixels or untrusted media.
- **Path tests:** schema and integrity-binding tests plus browser accessibility
  tree and screen-reader qualification after owner contract exists.
- **Path evidence:** owning PDP review and qualified host test; local component
  assertions cannot establish this decision.
- **Evidence Generator enhancement:** none before owner semantics are defined.
- **Convergence impact:** player accessibility and complete task acceptance
  remain blocked; this does not block the caption-transcript increment.

## Independent review and disposition

A Luna reviewer confirmed the authored-cue transcript follows PDP-2/PDP-3 and
found no additional local security, correctness, or operability defect. The same
review confirmed that a transcript cannot substitute for non-verbal visual
description and that no separate manifest field/binding is owner-defined.

`not-converged-actionable`: the source-bound transcript is implemented and
verified; continue with owner-defined accessible-alternative semantics and
independent host/rights work. This review does not change task status or
lifecycle authority.
