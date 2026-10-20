# Media Product Definition Source Index

This page is a navigation aid. Product meaning and phase completion come from the canonical source files below.

## Canonical definitions

- PDP-0 Product Truth: `.product-experience/pdp-0-product-truth/`
- PDP-1 Canonical Domain & Data: `.product-experience/pdp-1-domain-data/`
- PDP-2 Design Language & Interface System: `.product-experience/pdp-2-design-interface-system/`
- PDP-3 Complete Product Experience: `.product-experience/pdp-3-product-experience/`
- Shared authority and source ownership: `.product-experience/authority-map.yaml`, `.product-experience/source-manifest.yaml`
- Physical and composite surface scope: `.product-experience/surface-registry.yaml`, `.product-experience/surfaces/media-physical-topology.v1.json`
- Phase order and obligations: `config/closure/media-product-definition/phase-program.json`

## Current status and source checks

Read the source-pinned phase status files in `docs/implementation/pdp-{0,1,2,3}-phase-dev-status.json`. The generated surface matrix is `docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json` for PDP-0 and `pdp1-surface-phase-status-matrix.json` for PDP-1.

PDP-0 audit identities and their exact source dispositions are recorded in `docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json`; exact PDP-0 joins are recorded in the adjacent `pdp0-audit-aq-traceability.json`. These are traceability records, not alternate product requirements.

The native PDP-0 source verification entrypoint is:

```sh
node scripts/report-media-pdp-readiness.mjs --verify --phase-dev-status=PDP-0 --write
```

Read the resulting status record after the command completes. Continue with the next PDP phase only when the current phase is source-current `DEV_COMPLETE` with zero phase-local definition tasks outstanding.
