# Executable representation authority

This directory records which executable implementation has been reviewed and admitted against the four Product Definition phases. Source code, a package export, a screenshot, or an Explorer route is implementation evidence; none of those facts alone is an admission.

## Current status

- The registry is new and contains **zero admissions**.
- The inventory in `../pdp-2-design-interface-system/executable-ui-inventory.json` documents the existing Media UI package, AI Voice React sources, Explorer renderer, and archived desktop applications. Inventory entries are not admitted representations.
- `libs/audio-video-ui` remains the one active Media presentation package. No second UI package is introduced.
- Shared design-system package binding is unverified. The package manifests request `0.1.2`, while the available Shared source inventory records `0.1.0-SNAPSHOT`; this registry does not claim qualified consumption.
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
