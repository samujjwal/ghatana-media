# Composition: `media.composition.repository-root`

Root aggregate composition — the whole repository as one product.
Children: all physical surfaces, logical surfaces and sibling
compositions.

## Input / output

Input: source tree, build graph, surface roster, contract manifests.
Output: one coherent Media product — no duplicated definitions, one
canonical writer per concern, ownership boundaries enforced.

## Authority

- `AGENTS.md`/`CLAUDE.md` governance; `docs/development/
  SURFACE-IMPLEMENTATION-PLAN.md` execution plan;
  `.product-experience/` PDP sources own product meaning;
  `docs/implementation/MEDIA-SURFACE-ROSTER-RECONCILIATION.v1.json`
  owns the 56-identity roster (28 physical / 21 logical / 7
  compositions).
- Canonical writer boundaries: Media runtime + `providers/aws-postgresql`
  own job/artifact finality; adapters project only.

## Failure / rollback

Build graph or roster drift fails `check:surface-roster` /
`check:backend-remaining-surfaces-plan`; contract drift fails parity
checks. No silent second writers — detected via ownership audits.

## Cross-child behavior test

Cross-module source/build dependency tests; single-writer and
ownership-boundary checks; no stray build targets; all implemented
journeys exercised across UI/SDK/CLI/agent APIs without duplicated
definitions. Roster reconciliation: `pnpm check:surface-roster` (PASS —
56 identities, 56 matrix-bound, 0 unbound).

## Data flow

PDP sources → contracts (`runtime-contracts`, OpenAPI/proto,
`libs/audio-video-types`) → physical implementations → logical channels
→ compositions → journeys.
