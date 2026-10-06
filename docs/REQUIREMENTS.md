# Media requirements and current-state ledger

The editable Media-specific requirements are maintained under
[`.product-experience/phase-0-product-truth/requirements.yaml`](../.product-experience/phase-0-product-truth/requirements.yaml).
This document explains the current implementation and verification boundary;
it is not a replacement requirements registry.

## Current required surface

The source tree must preserve one canonical Product Definition root and expose
deterministic, source-linked projections for all applicable GUI, CLI, API, SDK,
event, and service surfaces. The current local proof covers:

- 462 Phase 0 capability leaves with family, requirement, state, authority,
  recovery, provenance, and proposed channel references.
- 28 Phase 1 component contracts with explicit design, action, state,
  accessibility, localization, and prohibited-use fields.
- 47 Phase 2 screen contracts, 30 registered journeys, and 28 required journey
  proposal files.
- A deterministic synthetic simulation/CLI and a read-only browser Explorer
  with Product, Explore, Specification, and Verify modes.
- Stable source-derived Explorer records with canonical locations, relation
  metadata, verification status, and explicit pending currentness.
- Local cross-phase validation proving capability-family-requirement, component,
  screen, journey, action, and view references resolve without dangling IDs.

The repeatable local proof command is:

```sh
pnpm check:product-experience-local
```

## Vision and downstream coverage

The requirements registry contains 38 functional requirement groups, 462
capability leaves, and 13 non-functional/decision records. The local checker
now verifies that every P0 outcome is represented in the journey outcome
coverage ledger and that every functional requirement has a non-empty outcome
trace. The settings/policy outcome is intentionally represented by the
supporting M-SETTINGS view because the master plan does not define it as an
independent end-to-end journey.

The complete mapping is maintained in
[PRODUCT-DEFINITION-COVERAGE.md](PRODUCT-DEFINITION-COVERAGE.md). It records
the master-prompt phase crosswalk, outcome-to-requirement and
outcome-to-journey/view links, all applicable machine-facing surfaces, and
which remaining gaps require owner decisions rather than local inference.

## Current-state gaps

The following are required before phase acceptance, but cannot be inferred or
closed by local source edits:

- P0-010 independent semantic review and owner appointment for affected domain
  capability and quality decisions.
- Published Tools schema, validator, Evidence Generator, currentness, and
  receipt bindings.
- Released Shared design-token/component bindings and independent
  accessibility, localization, visual, and human review.
- Owner-approved API/SDK/event contracts, consumer parity, runtime
  qualification, privacy/erasure/SLO evidence, and supply-chain admission.

The authoritative cross-phase list is
[`gaps.yaml`](../.product-experience/gaps.yaml). Unknown or unapproved work
remains blocked; this file does not convert it into a completion claim.

## Improvement backlog

Full runtime realization for all proposal views, provider/model qualification,
production browser hosting, broad visual campaigns, and release publication
are improvement or release work after the current owner and evidence gates.
They must not be implemented as local substitutes for the missing authority.
