# R9-R08 source owner workflow plan

**Scope:** one bounded PDP-0 Product Truth source successor for the frozen R9-R08 selected cut. This plan is an execution sequence, not a grant of authority or a claim that any gate has passed.

## Current evidence and blockers

- The frozen R9-R08 semantic peer review reports `PASS_FOR_FROZEN_R9_R08_SELECTED_CUT_ONLY`, zero semantic findings, and explicitly limits its result to the selected candidate semantics. It is technical semantic evidence, not source-owner adoption, root adoption, registration, or apply authorization.
- The canonical PDP-0 status is `IN_PROGRESS` (`docs/implementation/pdp-0-phase-dev-status.json`, SHA-256 `6e92932ba4173c6dea7e3dcee0c1d44a44ae90245804d363c0d22c2f28028b7c`). The phase currentness review reports seven stale guarded pins; the outstanding PDP-0 task inventory remains unknown while those pins are stale.
- The exact read-set and four candidate target preimages/postimages are in `media-pdp0-root-selected-source-integration-r9-r08.technical-source-root-inputs.v1.json`. Its authority state says proposal preparation only and canonical application is not authorized or performed.
- The required source-owner decision, root-adoption decision, profile registration, apply authorization, and active root delegation/revocation evidence are absent. Prior R9-R07 decisions do not establish R9-R08 authority.

## Ordered bounded workflow

| Step | Owner / evidence | Action and pass condition | Stop condition / next legal action |
| --- | --- | --- | --- |
| 1. Review inputs | Root authority actor | Review the root-input package, frozen candidate, freeze, semantic peer review, seven-member ordered read-set, four target rows, and the proposed PXD-901..905 sections. Independently confirm exact scope, actor/role mapping, policy boundary, and proposed validity window. | If any proposal, role, scope, or input is rejected or ambiguous, do not activate delegation; return a scoped correction request. |
| 2. Record delegation and revocation state | Root authority actor | If approved, author the real bounded delegation and the actual revocation-register record, choose an explicit validity interval, and recompute affected decision-section and whole-log digests. These records must identify this exact profile, candidate, freeze, semantic review, source baseline, and four targets. | A draft, null validity interval, stale digest, missing revocation record, or unrecorded role is not active authority. Stop before source-owner decisions. |
| 3. Revalidate owner inputs | PDP-0 source owner | Reload the seven exact read-set members and four target preimages. Confirm raw decision-log bytes and PXD-225 section match the package; independently review the frozen postimages against the selected definitions and crosswalk. | Any drift or changed meaning invalidates the frozen input binding. Do not apply; refresh the owning PDP-0 definition/candidate and rerun affected semantic review. |
| 4. Record source-owner adoption | PDP-0 source owner | Record the exact R9-R08 source-owner decision against the active delegation and current digests, including acceptance criteria for the four target rows. | No inferred adoption from peer review or prior R9-R07 authority. If not explicitly recorded, stop. |
| 5. Record root adoption | Root adopter | Review the source-owner record and exact frozen scope, then record a distinct R9-R08 root-adoption decision. | Missing source-owner predecessor, invalid delegation, stale input pins, or rejected candidate blocks this step. |
| 6. Register profile | Profile registrar | Register only `media.pdp0.root-selected-source-integration.r9-r08.source-only-technical.v3`, binding the current candidate, freeze, semantic review, authority records, and exact target rows. | No profile reuse from R9-R07 or registration by implication. Any digest mismatch stops the chain. |
| 7. Author exact apply authorization | Apply authority | Separately record authorization for the exact four-target R9-R08 source apply, bound to the active delegation, all predecessor records, exact fresh read-set, and exact frozen postimages. Keep native verification, PDP acceptance, Build, Delivery, and release explicitly outside scope. | Authorization absent, expired, revoked, mismatched, or stale means no apply. Do not substitute a technical test result or this plan. |
| 8. Final preflight and apply | Authorized apply actor | Immediately before execution, re-read the seven source inputs and verify every ordered hash, PXD-225 section hash, whole decision-log byte hash, target preimage, authority record, revocation state, and postimage hash. Run the fixed no-argument v3 command only if every check passes. | Any mismatch blocks with no source effect. An interrupted/partial result is `UNKNOWN`; reconcile the durable journal and readbacks before any retry. |
| 9. Verify bounded result | Independent technical verifier | Confirm the four exact targets equal their frozen postimages, all other protected inputs remain unchanged, and the durable journal/readbacks agree. Record the result as source application evidence only. | Do not claim PDP-0 currentness, task completion, acceptance, native receipt, Build, or release from this result. |
| 10. Reconcile PDP-0 currentness | PDP-0 status owner | Through the repository's owner-controlled refresh/validation workflow, update only affected source pins and determine the actual phase-local task inventory. Preserve the full 54-identity / 216-cell campaign denominator. | If source meaning or dependent definitions changed, reopen the earliest affected PDP-0 definition and declared dependents. Do not mark PDP-0 `DEV_COMPLETE` while tasks are unknown or nonzero. |

## Acceptance evidence for this bounded workflow

The R9-R08 source successor is complete only when (a) the active delegation, revocation state, source-owner adoption, root adoption, profile registration, and separate exact-input apply authorization are all genuine, current, digest-bound records; (b) the apply's seven-member read-set and four exact postimages pass fresh preflight; and (c) four target readbacks and the durable journal confirm the exact bounded result. This does not establish whole-campaign Discovery completion or PDP closure.

## Stage boundary

- **Selected work:** DISCOVERY / PDP-0 source definition and currentness only.
- **Build lane:** not entered by this source workflow; any eligible independent BUILD unit requires its own PDP-0..3 and dependency admission.
- **PDP closure lane:** separate and not authorized by this plan or the semantic peer review.
- **Delivery gate:** closed until current PDP closure/acceptance, Build verification, owner approval, and environment/release prerequisites exist.
- **Next allowed phase:** remain in PDP-0 until its source pins are current and its local task inventory is known; only then evaluate the next applicable PDP phase and declared dependencies.
