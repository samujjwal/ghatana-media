# Increment 5: Governed Feedback and Learning

## Authority boundary

The Increment-3/4/4A freeze set (`docs/evidence/document-intelligence-freeze-set.v1.json`) is **FROZEN**. Its Shared contract, canonical provider authority, model authority, runtime dependency authority, capability inventory, and leaf inventory remain unchanged.

Increment 5 consumes the frozen Increment-4 review/correction model as **input authority** and produces **candidate learning artifacts** — feedback events, datasets, calibration candidates, template candidates, extraction-policy candidates, model candidates, shadow evaluations, and promotion receipts.

Production activation of any learning artifact is forbidden without an explicit, receipted promotion. A user correction never mutates active provider, model, template, calibration, alias, or routing authority as a side effect.

Increment 5 may not change `ParsedDocument`, `ExtractionCandidate`, execution or review states, evidence semantics, Shared provider ports, Shared authority admission, or any artifact bound by the freeze set.

The consolidated I5 authority also covers reviewer authorization and deterministic
conflict handling, poisoning/untrusted-correction quarantine, independently frozen
qualification holdouts, subgroup sufficiency (insufficient support is
`NOT_QUALIFIED`), model/data-license provenance, descendant revocation impact, and
the separation between qualification and production activation. Native closure
remains the owner of every I5 criterion; this document is implementation authority,
not a second closure ledger.

## Scope

- Immutable feedback-event projection from review/correction lineage (product side)
- Explicit feedback eligibility, privacy minimization, and revocation/tombstone propagation
- Deterministic dataset materialization: canonical deduplication, group-safe train/eval split, leakage checks, statistics
- Confidence-calibration, template-discovery, extraction-policy, and external-model candidates — all `CANDIDATE` until promoted
- Active-learning review prioritization with persisted reason codes and score components
- Candidate registry with dependency graph, offline evaluation, regression budgets, shadow evaluation, governed promotion, and rollback
- Learning audit trail, retention policy, capability states, and a read-only strict verifier
- Tenant learning governance (added by program revision, `docs/PROGRAM.md`): dataset tenant scope with `TENANT_LOCAL` default (I5-34), distinct `learningEligible` authority (I5-35), learning RLS predicates (I5-36), `document-learning.*` permissions with privileged promotion (I5-37), cross-tenant candidate guard (I5-38), export controls (I5-39), revocation propagation without manifest rewrite (I5-40), and complete candidate reproducibility binding (I5-41)

Promotion publishes a new *candidate* authority revision (e.g. `learning-next-rN`); it never activates and never mutates `default` or Increment-4 consumer admission.

## Consolidated I5 completion boundary

The implementation boundary is complete when the candidate-only profile contains
versioned feedback, dataset, calibration, template, extraction-policy, model,
evaluation, shadow, and promotion authorities; every artifact carries source,
review, correction, scope, and dependency lineage; and the following controls are
enforced:

```text
reviewValid != learningEligible
TENANT_LOCAL is the default dataset scope
revocation omits future examples and records descendant impact
frozen holdouts never move into training
same source/review families never cross dataset splits
candidate evaluation and promotion bind the same immutable identity
qualification publishes an authority; activation is a separate release decision
no production correction performs online learning
```

The native owner mapping is `org.document-extraction.learning` with criterion
`org-document-extraction-learning-verify`. Read-only strict reconciliation consumes
receipts and never executes providers or mutates canonical/default authorities.

## Invariants

```text
0 silent active-authority mutation — corrections never rewrite live policy
0 untraceable training labels      — every datum binds source/review/authority lineage
0 train/eval source leakage        — same source or review lineage never crosses the split
0 promotion without authorization  — promotion requires PASS evaluation, PASS regression budget, explicit authorization, current material
0 promotion by mutation            — promotion publishes a new authority revision; rollback selects a prior qualified revision
0 protected-text audit leaks       — learning audit records identities and digests, not document text or extracted PII
```

## Surfaces

```text
learning/schemas/            versioned, immutable-after-publication JSON Schemas
learning/feedback/           feedback event loading, eligibility, tombstones
learning/datasets/           deterministic dataset builder, dedup, split, leakage, stats
learning/calibration/        calibration evaluator + candidate emission
learning/templates/          template candidate discovery + provenance
learning/policy/             GLiNER extraction-policy candidate generation
learning/models/             external candidate-model hook contract
learning/active_learning/    review-priority scoring + governed queue
learning/candidates/         registry, dependency graph, offline evaluation, shadow
learning/promotion/          promotion authorization + rollback
learning/audit.py            learning audit trail
learning/retention.py        retention policy authority
learning/policies/           checked-in eligibility/dataset/budget/retention policies
learning/util.py             canonical JSON, digests, atomic writes, schema validator

products/org/apps/api/src/modules/document-extraction-learning/
  feedback-projector.ts      immutable FeedbackEvent projection (product side)
  feedback-eligibility.ts    terminal-outcome eligibility + ownership checks
  feedback-privacy.ts        pseudonymization + protected-field redaction
  feedback-event-store.ts    append-only event store + revocation tombstones
  learning-feedback.service.ts  durable review/correction assembly
  feedback-projector.spec.ts    focused Vitest coverage

The product projector lives in a sibling module, NOT inside
`modules/document-extraction/`, because that tree is Increment-4 semantic
material: any new file under it would change the sealed
`orgApiImplementationFingerprint` and invalidate sealed I4 leaves.
```

## Closure

`scripts/verify_increment5.py --strict` is read-only and derives all leaves from real evidence and frozen fingerprints. Closure requires:

```text
noSilentActiveMutation   = PASS
datasetsReproducible     = PASS
candidateProvenance      = PASS
promotionsAuthorized     = PASS
activeAuthorityBinding   = PASS
capabilityAdvertising    = PASS   (I5 capabilities honest in the registry)
```
