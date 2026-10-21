# Ghatana Media product definition authority

`.product-experience/` is the canonical editable source for Media product meaning across PDP-0 through PDP-3. Each phase owns its definitions in one phase directory. Product definitions describe intended behavior; they do not claim implementation, acceptance, qualification, or release. No Media application has been released.

## Phase authorities

| Phase | Canonical source | Owns |
| --- | --- | --- |
| PDP-0 Product Truth | [`pdp-0-product-truth/`](./pdp-0-product-truth/) and [`PRODUCT-TRUTH.md`](./pdp-0-product-truth/PRODUCT-TRUTH.md) | Product outcomes, scope, requirements, capabilities, rights, trust, quality, and user intent |
| PDP-1 Canonical Domain & Data | [`pdp-1-domain-data/`](./pdp-1-domain-data/) | Domain identities, data, operations, states, events, guards, versions, and finality |
| PDP-2 Design Language & Interface System | [`pdp-2-design-interface-system/`](./pdp-2-design-interface-system/) | Accessible visual and headless interface rules, components, and API/CLI/SDK/event semantics |
| PDP-3 Complete Product Experience | [`pdp-3-product-experience/`](./pdp-3-product-experience/) | Supported and unsupported complete experiences, channels, journeys, screens, actions, and outcomes |

Edit the owning phase source when product meaning changes. Downstream phase definitions must follow the declared dependencies. Moving implementation code does not move semantic authority.

## Artifact index, projections, and status

[`source-manifest.yaml`](./source-manifest.yaml) is the generated portable artifact index for declared artifact identities, locations, roles, and phase relationships. Use it to inspect the repository's declared source graph; it does not own product meaning or establish source currentness, phase status, acceptance, or release. Regenerate it from its authored inputs rather than hand-editing generated entries. Generated candidate documents and the [Experience Explorer](../apps/media-experience-explorer/README.md) are projections; they do not create a second definition source.

The source-pinned phase status records are [`PDP-0`](../docs/implementation/pdp-0-phase-dev-status.json), [`PDP-1`](../docs/implementation/pdp-1-phase-dev-status.json), [`PDP-2`](../docs/implementation/pdp-2-phase-dev-status.json), and [`PDP-3`](../docs/implementation/pdp-3-phase-dev-status.json). Validate each record with its [phase-readiness reporter](../scripts/report-media-pdp-readiness.mjs) and native fingerprint rules: a pin may cover a whole file, an anchored section, or a generated projection. Do not compare a section or projection pin with a raw whole-file hash. Currentness is `UNKNOWN` until the owning validator confirms the recorded inputs. Matrices and reports are projections, not alternate status authorities. `DEV_COMPLETE` describes definition development only; it is separate from owner acceptance, implementation, closure, qualification, and release.

## Governance and navigation

- [`authority-map.yaml`](./authority-map.yaml) names the role of each authored, derived, or external authority.
- [`decision-log.md`](./decision-log.md) records bounded decisions and their scope.
- [`artifact-identities.yaml`](./artifact-identities.yaml) preserves stable artifact identities.
- [`gaps.yaml`](./gaps.yaml) is the editable cross-phase gap register.
- [`surface-registry.yaml`](./surface-registry.yaml) is the canonical intended consumer surface inventory. [`surfaces/media-physical-topology.v1.json`](./surfaces/media-physical-topology.v1.json) separately records physical candidates, compositions, the root aggregate, and consumer crosswalks; the two inventories have distinct denominators.
- [`acceptance.yaml`](./acceptance.yaml) records acceptance inputs; its presence does not mean acceptance has occurred.
- [`traceability.yaml`](./traceability.yaml) records authored source relationships.
- The Expert-Reviewed Master Plan is linked from [`source-manifest.yaml`](./source-manifest.yaml) as migration reference only; it is not semantic authority or an active PDP scheduler.
