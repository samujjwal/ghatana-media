# Contract definition records — ghatana-media

This directory contains non-authoritative, reproducible definition-review metadata for the bounded MED/RUN contract-definition campaign. It does not replace the repository's product semantics, API schemas, provider contracts, runtime registries, or Closure/Assurance v1 records.

- `surface-matrix.json` records classified surfaces, source authorities, applicable contract dimensions, findings, validation results and per-source SHA-256 fingerprints.
- `task-register.json` records the owner work items and their disposition.
- `mandatory-area-review.json` is the required 33-area scoped audit.
- `static-validation.json` records reproducible static command outcomes; no runtime or lifecycle execution is included.

Source commit recorded for the initial audit: `80ade36ffea702ee183afe610f2be07e1d9876de`. Current source fingerprints are per-file; a clean commit does not imply acceptance or readiness.

Consumer guide: `docs/architecture/MEDIA_CONTRACT_BOUNDARIES.md`.

Matrix projection commands (run from the repository root):

```sh
python3 scripts/contract-definition/generate.py . ghatana-media
python3 scripts/contract-definition/validate.py
```

The scripts live under `scripts/contract-definition/`; `.ghatana/definition/` contains review metadata and generated projections only.
