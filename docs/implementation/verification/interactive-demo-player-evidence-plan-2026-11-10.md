# Interactive demo player local evidence plan — 2026-11-10

## Scope and intent

- Surface: `libs/audio-video-ui/src/player` inside `@audio-video/ui`.
- Source task: `media.dev.interactive-demo-player` in
  `docs/development/remaining-work.json` (task status remains OPEN).
- Product inputs: PDP-2
  `.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml#surfaceInterfaces/media.surface.interactive-demo-player`
  and PDP-3
  `.product-experience/pdp-3-product-experience/recorder-studio-experience.yaml#interactiveDemoPlayerExperience`.
- Baseline source revision: `0a439def32fe213aae57d64bcd7f4fc2853d5921`.
- Goal: add a text transcript from exact, already-bound caption cues without
  changing the manifest schema, its public exports, source truth, or host trust.

## Scope fingerprint

Record the revision plus SHA-256 for the following source inputs after the
implementation: `libs/audio-video-ui/package.json`,
`libs/audio-video-ui/src/player/interactiveDemoPlayer.tsx`,
`libs/audio-video-ui/src/player/interactiveDemoState.ts`,
`libs/audio-video-ui/src/player/interactiveDemoPlayer.test.ts`, and
`libs/audio-video-ui/test/interactive-demo-player/browser.test.mjs`. The
package lock, exported manifest shape, and generated export map are included in
the check because this change must not modify them. The pre-edit worktree was
already dirty and no pre-edit digest was recorded, so this plan makes no
before/after source-fingerprint comparison claim. The post-implementation
working-tree fingerprints are:

| Path | SHA-256 |
|---|---|
| `libs/audio-video-ui/package.json` | `8b9c8609671a02567d15bb0373974005fe7b422145ee2ce6fb67bab7bce2221e` |
| `libs/audio-video-ui/src/player/interactiveDemoPlayer.tsx` | `77ccd937cd0f424ca80816ad6680b77cb2283b42d53eb1928f5577be6c8a6bb8` |
| `libs/audio-video-ui/src/player/interactiveDemoState.ts` | `baf7050df8942d23438a89d14bed1e09591603f430892c7328e6ab109a09b081` |
| `libs/audio-video-ui/src/player/interactiveDemoPlayer.test.ts` | `9b32f9013baf794c1a950378b703f5b38eeda632036234a3b07cfa787b74baa8` |
| `libs/audio-video-ui/test/interactive-demo-player/browser.test.mjs` | `2b8a956eb2cd44b36018eaaac5aa82019fda296ef9c70c031fe1a37189f4d860` |
| `.product-experience/executable-representation/export-map.yaml` | `81b25ba6c678deb0a7a3bf7c0c56cc0617a9c4afc8e9176bacc76d86dcc284b2` |
| `pnpm-lock.yaml` | `0cbfe653a3fcf41fc71379ae3d315fdb2f5d269aaeda1f2404baa1ab019c61bb` |

The lockfile was already dirty at task start; this increment added no
dependency. The task progress entry records command results and any remaining
limits; this plan is not a PDP or release artifact.

## Acceptance and expected evidence

1. The open transcript renders only while the exact host-attested scene is
   READY, includes every bound cue once in chronological order with its exact
   millisecond start, and changes to the newly attested scene after a branch.
2. Transcript disclosure is reachable by native keyboard controls and exposes
   semantic text/time to DOM accessibility queries. No transcript text is
   generated from pixels, unbound assets, stale captions, or scene labels.
3. Existing branch/replay/seek, media playback, origin-denial, stale-version,
   and truthful live/curated/simulation-label behavior stays intact.
4. No package export, public manifest field, runtime route, network capability,
   provider, signature verifier, or product effect is added.
5. Verification output: focused player Vitest; full affected UI package
   typecheck, Vitest, and build; pinned loopback browser selector; surface-doc
   check; refreshed executable observations, product manifest and partial
   experience candidate checks; `git diff --check`.

## Commands

```bash
pnpm --filter @audio-video/ui exec vitest run src/player/interactiveDemoPlayer.test.ts
pnpm --filter @audio-video/ui check
pnpm --filter @audio-video/ui test:interactive-demo-player:browser
pnpm check:surface-docs
pnpm refresh:executable-representation-observations
pnpm generate:product-definition-manifest
node scripts/generate-media-phase-projections.mjs --only=experience-specification --check
pnpm check:product-definition-authority
pnpm check:product-experience-local
pnpm check:sdk-declaration-crosswalk
pnpm check:design-conformance
git diff --check
```

Focused player Vitest passes 24/24, pure state selector 22/22, full package
check passes typecheck, 181/181 UI tests and build, and the loopback selector
passes 5/5 with zero skips/failures/errors using the pinned fixture/toolchain.
The 21-file source/contract Node suite passes 244/244. Surface docs pass at 59
READMEs/577 cited types; usable-surface check reports 9 areas/72 open tasks/56
surfaces/30 journeys/469 leaves and its tests pass 6/6. Product Definition
authority and local experience checks pass; the generated product manifest has
375 records/376 Explorer records and the experience candidate is
schema-valid/public-validator PASS, still NOT_ACCEPTED_NOT_CURRENT. `pnpm
check:design-conformance` reports zero unexplained findings but exits blocked
on `shared-artifact-binding EXTERNAL_PENDING` and
`conformance-and-specialist-review INDEPENDENT_PENDING`; these gates remain
open and no product source or status was promoted. `git diff --check` is clean
after final documentation updates.

The creative-preview example generator is unchanged and its existing WAV
fixture digest is pinned in the logical player guide. Regenerate it only if its
source changes. Do not run Java module, production-host, full-browser-suite,
rights, or lifecycle-closure checks for this React-only local rendering
change. No repository Evidence Generator produces an admitted screen-reader
or host qualification result; do not claim either from DOM assertions. The
user-approved local browser references remain regression inputs, not design
owner acceptance.

## Limits

This proves the local player contract only. PDP-2/PDP-3 call for an accessible
alternative; the manifest has no owner-defined scene visual-description field.
The implementation must not invent that source data. Human screen-reader
qualification, signed production-host verification, lawful source rights,
hosted playback, and canonical project/artifact binding remain independent.

The approved local browser references were freshly re-run with `pnpm --filter @ghatana/media-experience-explorer test:visual-regression`: Playwright audit PASS (31 scenarios, 47 Product routes, 376 specification records, no failures/console/page errors/policy violations), and decoded PNG comparison PASS (8/8 exact pixel matches, 0 mismatches). Result JSON: `/var/folders/ct/rbzll5l91xj9hw30s3j768yc0000gn/T/media-experience-visual-regression.boqkPu/report.json`. Manual screen-reader/independent-review gates remain `MANUAL_NOT_VERIFIED` and canonical references remain `NOT_SUPPLIED`; these captures remain local regression references.
