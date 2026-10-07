# Executable representation authority

This directory records which executable implementation has been reviewed and admitted against the four Product Definition phases. Source code, a package export, a screenshot, or an Explorer route is implementation evidence; none of those facts alone is an admission.

## Current status

- The registry is new and contains **zero admissions**.
- The inventory in `../pdp-2-design-interface-system/executable-ui-inventory.json` documents the existing Media UI package, AI Voice React sources, Explorer renderer, and archived desktop applications. Inventory entries are not admitted representations.
- `libs/audio-video-ui` remains the one active Media presentation package. No second UI package is introduced.
- Media's frozen pnpm composite install and Explorer dependency-closure build/typecheck pass using local Shared and Tools sources. The separate packed Shared consumer also passes TypeScript and Vite runtime checks against nine local `0.1.0-SNAPSHOT` artifacts. Public registry resolution and immutable release binding remain unverified; local source resolution does not establish publication, owner acceptance, or visual qualification.
- `ghatana-tools` owns reusable Product Definition/Experience mechanics and the generic Explorer host/package contracts. Media supplies its product declarations and facts through those contracts. `ghatana-lifecycle` owns cross-repository closure, evidence admission, semantic currentness, receipts, readiness, and convergence outputs; this inventory does not assign those results.
- The package's exported screen compositions are candidate implementation surfaces. Their underlying journey and screen proposals remain subject to Product owner review and this admission process.
- `@audio-video/ui/styles.css` is a public structural and accessibility stylesheet for hosts without the Shared utility-class pipeline. It uses semantic system colors and remains a fallback, not a qualified Shared theme or canonical Media token bundle.

## Admission process

1. Inventory the source, consumers, public export, and current implementation evidence.
2. Bind one bounded representation to the applicable PDP-0, PDP-1, PDP-2, and PDP-3 records and semantic digests.
3. Record platform scope, covered states and variants, responsive/accessibility/localization evidence, dependencies, and allowed host ports.
4. Attach conformance evidence and human review evidence. An unresolved dependency or pending acceptance authority keeps the record unadmitted.
5. Add a record under `admissions/` and update `export-map.yaml`, `host-map.yaml`, and `migration-ledger.yaml` together.

`acceptanceState: admitted` is reserved for an explicit acceptance authority with review evidence. `candidate`, `inventory-only`, `blocked`, and `retired` do not grant admission.

## Files

- `admission-schema.yaml` defines required record fields and controlled values.
- `admissions/` is intentionally empty of admission records until review evidence exists.
- `export-map.yaml` inventories package public exports and their admission status.
- `host-map.yaml` records current and intended hosts without asserting import identity.
- `migration-ledger.yaml` tracks migration disposition and unresolved work.
