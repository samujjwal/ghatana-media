# Media → Lifecycle gtool phase closure handoff

**Campaign:** all 54 Media PDP source identities on `main`. **Stage:** BUILD, parallel native PDP closure lane. **First phase:** PDP-0 product-truth definition acceptance. **Discovery:** definitions previously reported current and DEV_COMPLETE, zero remaining phase-local definition tasks; revalidate exact current material. **Native closure:** no CLOSED/CURRENT receipts confirmed by latest recorded clean-main gtool readback.

**Canonical execution plan:** [Lifecycle Media gtool phase management runbook](https://github.com/samujjwal/ghatana-lifecycle/blob/main/docs/engineering/MEDIA_GTOOL_PHASE_MANAGEMENT_RUNBOOK.md). Lifecycle owns gtool workflow and trusted contract/snapshot/receipt authorities. Media owns topology, obligation/case mappings and product proof cases.

## Stable source meaning and scope

The 54 rows comprise 26 physical candidates, 6 intermediate compositions, one root and 21 logical consumers. They are source identities, **not** 54 admitted Lifecycle ClosureSurfaces. Keep all 54 in each source phase matrix. The current single logical aggregate `media.product-definition` with 8,664 candidate obligations must not be closed as an opaque replacement for actual physical leaf/composite ownership.

| Source phase | Native Lifecycle PhaseProgram ID | Obligations at previous source readback |
| --- | --- | ---: |
| PDP-0 | `media.product-truth.definition-acceptance` | 4,028 |
| PDP-1 | `media.canonical-domain-data.definition-acceptance` | 2,336 |
| PDP-2 | `media.design-interface-system.definition-acceptance` | 436 |
| PDP-3 | `media.complete-product-experience.definition-acceptance` | 1,864 |

The source-current matrices and source manifest are the authoritative baseline, not this table. Prior L02 had 65 candidate links / 44 linked obligations / 8,620 unmapped; L03 had five candidates and zero admitted; observers, oracles and receipts were zero. Never infer execution proof from source links.

## Media owner execution work

1. [Issue #19 — exact source-to-surface/phase/obligation/case topology](https://github.com/samujjwal/ghatana-media/issues/19). Reconcile all 54 identities with actual physical owners, leaf/composite dependencies, applicability/N/A/archive, unique obligations and source-pinned case assertions. Start with PDP-0. Explicitly retain unmapped items until real source/case evidence exists.
2. [Issue #20 — native proof routes and first actual PDP-0 leaf receipt](https://github.com/samujjwal/ghatana-media/issues/20). Admit trusted observers/oracles, executable cases and the fixed canonical Evidence Generator route. Use Lifecycle gtool immutable RunPlan → re-admitted execution → canonical result/receipt readback, only after all prerequisites.

**External trusted-authority prerequisites in Lifecycle:** [AP-02 contract distribution and verifier #24](https://github.com/samujjwal/ghatana-lifecycle/issues/24); [AP-03 source snapshot and Planner verifier #25](https://github.com/samujjwal/ghatana-lifecycle/issues/25). These are owner/host registrations, not Media-authored JSON stubs. AP-02/AP-03 may progress in parallel with Media mapping; final consumer admission requires both.

**Independent BUILD:** proceed with F00/F01 and otherwise ready source-grounded implementation packages under [the canonical Build plan](https://github.com/samujjwal/ghatana-media/blob/main/docs/implementation/MEDIA-BUILD-IMPLEMENTATION-PLAN.md) without requiring native PDP closure to start. Never treat mock Explorer evidence as actual product functionality. PDP-3's source-owned narrated simulated J-03 recording and later real-product recording/equivalence are separately tracked; comply with the versioned criterion and do not claim real-product film verification from simulated media.

## Media owner acceptance conditions

- No lost, duplicated or guessed source identities; unique source obligations and explicit exact phase applicability; no children copied into aggregate obligations.
- All active applicable PDP-0 closure obligations covered by owner-reviewed genuine cases/negative oracles and actual admissible proof routes. Many-to-one coverage allowed only with each explicit assertion reviewed.
- Source generator, denominator audit and four phase matrix `--check` validations current on pinned bytes. Stable error IDs for every unresolved row.
- Source statuses remain `DEV_COMPLETE` unless actual changed definition meaning causes scoped impact; native acceptance/receipts stored only through Lifecycle authority.
- A `CLOSED/CURRENT` claim requires authentic canonical per-unit receipt readback. No mass owner simulation, bypass, bulk N/A or unsupported deferral.

This handoff tracks work packages and constraints; **writing it does not clear an AP authority gate, admit a proof, or close a phase**.

## Executable current-source setup and owner authorization (2026-10-22)

An owner-directed implementation-scope decision is recorded in `config/closure/media-product-definition/owner-execution-authorization.v1.json`. It approves Media preparation, source mapping, owner authority integration and independently eligible Build work, **not** fake verifier registration or receipt issuance. The detailed [next executable gtool batch](https://github.com/samujjwal/ghatana-lifecycle/blob/main/docs/engineering/MEDIA_GTOOL_NEXT_EXECUTION_BATCH_2026-10-22.md) is the current dependency-ordered execution queue.

Source readiness preflight is now executable and source-owned:

```sh
pnpm run test:gtool-closure-source
pnpm run audit:gtool-closure-source
pnpm run test:ap03-source-snapshot
```

For AP-03 selected-current material, create a genuine selected-member archive and a complete read-only owner-review candidate (archive path must be unique and outside the repository):

```sh
node scripts/prepare-media-ap03-snapshot.mjs \
  --create-archive \
  --archive /path/to/owner-state/media-selected-source.tar \
  --output config/closure/admission/media-source-membership.v1.json
```

The local manifest is deliberately ignored by Git because it includes an absolute checkout root; it must be bound into an exact run-specific trusted owner issuance. AP-02 requires the owner-registered contract distribution verifier; AP-03 additionally requires the source-snapshot owner and Planner verifier. Media source audit status cannot replace either approval. Source records may be prepared in parallel with Lifecycle host setup; native PDP closure only follows authentic consumer/graph/evidence admission.

The four PDP source statuses retain **zero** phase-local definition tasks, subject to fresh source validation. The remaining graph/case/verifier/receipt gaps are closure-lane obligations, not reason to re-open current PDP source definitions or stop source-eligible Build implementation.
