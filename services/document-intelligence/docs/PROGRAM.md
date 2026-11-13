# Document Intelligence Program Authority

Program-level execution plan for Increments 3–6. This document is the
sequencing authority referenced by `docs/INCREMENT-6.md`. It binds the
execution order, the implementation/verification barrier, the profile
compatibility boundary, and the task ledger additions from the closure review.

Existing task IDs (P0-*, I5-*, I6-*) keep their established meanings in code,
config headers, and `learning/README.md`. IDs introduced here continue each
series without renumbering.

## 1. Two-epoch execution model

```text
IMPLEMENTATION EPOCH                     VERIFICATION EPOCH
─────────────────────────────            ─────────────────────────────
P0 closure/invalidation infra            F1 I3 qualification (final tree)
RUN-* runner reliability                 F2 I4 qualification (final tree)
PROF-* profile authorities               F3 I4A freshness + stale leaves
PROTO-* wire-protocol freeze             F4 base seal (freeze-set.v1)
DB-*   migrations through I6             F5 I5 qualification
I3/I4/I4A remaining implementation       F6 I6 functional qualification
I5 complete implementation               F7 I6 load/soak/chaos (LAST)
I6 complete implementation               F8 I6 strict reconciliation
        ↓                                F9 global seal (freeze-set.v2)
IMPLEMENTATION_COMPLETE barrier
(document-intelligence-implementation-lock.v1.json)
```

Expensive campaigns run only after the final intended source shape exists.
I3/I4/I4A evidence already sealed under `freeze-set.v1` remains valid because
the material scopes are additive — later increments may not reopen them
without touching their declared material (proof-graph `owns`/`dependsOn`).

A post-lock defect fix feeds the dependency graph and invalidates only the
affected leaves; it does not restart an epoch.

## 2. IMPLEMENTATION_COMPLETE barrier — LOCK-01

**LOCK-01 — implementation lock.** Generate
`docs/evidence/document-intelligence-implementation-lock.v1.json` only after
all planned I3–I6 source/config/schema/tooling work is complete. Bind:

```text
source material scopes          wire protocol schemas
runtime/profile definitions     DB migrations
model manifests                 provider catalogs
learning schemas                I6 routing/scheduler configuration
test/catalog inventories        verification implementations
```

After the lock: no feature additions, refactors, formats, policies, or
provider behavior. Only fixes demonstrated by verification failures, each
routed through the proof graph for scoped invalidation.

## 3. Profile compatibility boundary — PROF-01..04

**PROF-01 — central profile manifest.** `profiles/` gains explicit files:
`default.yaml` (frozen I3/I4 canonical runtime — today the default is the
implicit no-profile runtime; make it an artifact), `increment4a.yaml`
(exists), `increment5-candidate.yaml` (new), `increment6-candidate.yaml`
(existing `increment6.yaml` already carries `consumerAdmission: DENIED`;
rename/alias under the candidate naming).

**PROF-02 — explicit enumeration.** Every profile enumerates providers,
models, formats, languages, routing, fallbacks, limits, admission
eligibility, capabilities. No auto-registration from installed code.

**PROF-03 — default invariant.** After all I5/I6 implementation merges:
`default` catalog before == `default` catalog after, unless a deliberate
canonical change was made and re-qualified. I5/I6 candidate providers must
never leak into `default`.

**PROF-04 — catalog equality check.** Strict verifiers assert the
pre/post-implementation `default` catalog projection is byte-identical.

## 4. Promotion and activation boundaries

**I5:** promotion publishes a *new next authority* (e.g.
`learning-next-rN`); it proves a candidate is eligible, it never activates
it and never mutates `default` or Increment-4 consumer admission. Consumer
activation is a later explicit release step. I5 qualification therefore
cannot stale I3/I4.

**I6:** qualification produces `increment6-qualified-rN` — not a `default`
edit. Consumer migration to a new authority happens through an explicit
consumer-admission/release act (see ADM-01).

## 5. Task ledger additions

### RUN-01..07 — campaign runner reliability (before any expensive wave)

```text
RUN-01 unique run-scoped ports; allocate+record, never assume fixed ports
       (the 18765/18766 collision in the I4A handoff is the evidence)
RUN-02 orphan cleanup: worker/native subprocesses, browser, DB sessions
RUN-03 SIGINT/SIGTERM/exception/timeout must not leave a RUNNING receipt
RUN-04 campaign-owned DB sessions verified closed before teardown
RUN-05 INFRASTRUCTURE_ERROR distinct from TEST_FAIL; bounded runner retry
       only for classified infra failures
RUN-06 resume reuses COMPLETE immutable leaves; never resumes into a
       half-completed leaf
RUN-07 teardown proof in every campaign manifest:
       workerStopped, nativeWorkDrained, dbSessionsClosed, tempFilesCleaned
```

### PROTO-01..04 — wire-protocol compatibility

```text
PROTO-01 freeze /v1 schemas (contracts/schemas/):
         /v1/providers /v1/parse /v1/extract /v1/embed /v1/operations/*
PROTO-02 backward-compat tests: final I6 runtime accepts canonical I3
         requests and produces an I3-compatible projection
PROTO-03 extensions additive only (attempt lineage, hybrid provenance,
         fallback reason) — optional metadata or new protocol revision;
         never reinterpret an existing field
PROTO-04 client records wireProtocolVersion + workerCapabilityVersion
         and rejects incompatible workers
```

### DB-01..05 — migration compatibility (inside implementation epoch)

```text
DB-01 all migrations through I6 complete before the final I4 campaign
DB-02 old I4 queries/workflows keep functioning on the final schema
DB-03 prefer additive migrations; never rewrite frozen I4 data semantics
DB-04 publish database-schema-compatibility.json mapping
       I4 tables / I5 additions / I6 additions
DB-05 rollback/forward-compat tests where supported
```

### I5-34..41 — tenant learning governance + reproducibility

```text
I5-34 dataset tenant scope: TENANT_LOCAL (default) |
      MULTI_TENANT_EXPLICITLY_AUTHORIZED | SYNTHETIC_PUBLIC
I5-35 reviewValid ≠ learningEligible — distinct stored authority
I5-36 RLS tenant predicates on feedback events, dataset/candidate
      metadata, active-learning queues, promotion requests
I5-37 permissions: document-learning.read / .manage / .promote;
      promotion more privileged than review
I5-38 tenant-local candidate cannot go global without explicit
      reclassification + authorization
I5-39 dataset export preserves fingerprint, scope, authorization,
      redaction policy, provenance
I5-40 revocation propagation: future snapshots exclude ineligible source;
      existing manifests record the revocation relationship, never rewrite
I5-41 candidate reproducibility binding: trainingCodeFingerprint,
      datasetFingerprint, baseModelFingerprint, dependencyLockFingerprint,
      tokenizerFingerprint, seed, hyperparameters, runtime, native libs;
      nondeterminism recorded explicitly; promotion proves
      evaluated == promoted, not same name
```

### I6-49..55 — hostile-input preflight

```text
I6-49 OOXML archive-bomb limits: compressed/expanded bytes, entry count,
      per-entry size, compression ratio, nested-archive policy
      (limits.py already carries partial bounds — complete + enforce)
I6-50 external-reference prohibition: no external relationships, remote
      resources, DDE-like links, external workbook links; no network fetch
I6-51 macro policy: never executed; inert-data accept or explicit reject
      per capability policy
I6-52 formula policy: XLSX never executes formulas; stored/displayed
      values under documented mapping
I6-53 embedded-object bounds: OLE/media/archives/attachments bounded or
      rejected, no unauthorized recursion
I6-54 PDF structural preflight: page count/dimensions, object count,
      decoded pixels, stream sizes, recursion depth
I6-55 image decompression guards before Paddle/Tesseract: pixel
      dimensions, decoded memory, frame count
```

### Further I6 extensions

```text
I6-56 scheduler tenant fairness: per-provider + per-tenant concurrency,
      per-tenant queued limit, fair scheduling, deadline-aware rejection;
      resource accounting (tenant, provider, pages, bytes, queue/exec
      time) without sensitive labels. BoundedScheduler already has
      max_tenant_share — extend, don't rebuild.
I6-57 retry vs fallback as distinct concepts: retry = same provider/
      authority + transient policy; fallback = different provider under
      declared routing. Independent attempt/deadline/eligibility/failure
      categories; fallback never resets the original request deadline
      (remaining-budget propagation).
I6-58 language-resolution.v1 authority: validated request hint →
      document/profile policy → supported detection (if enabled) →
      safe fallback/error; record selected language + reason; no silent
      Devanagari routing among ne/hi/mr; freeze Unicode normalization.
I6-59 office-projection.v1 authority: provider-neutral mapping —
      PPTX slide→page, shape ordering, text-region coords, notes policy;
      XLSX sheet ordering, cell identity, merged/hidden policy,
      formula/value mapping; DOCX page/render authority, paragraph/table
      order, headers/footers, remediation provenance.
I6-60 observability cardinality: bounded labels only (provider,
      capability, mediaType, language, status, failureCategory, profile);
      documentId/userId/fieldValue/tenant name/filename forbidden —
      correlation IDs go to traces, not metrics.
I6-61 acceptance thresholds complete before measured runs: extend
      evaluation/increment6/acceptance.yaml with hardware class, workload
      fingerprint, throughput floor, p99, queue-limit behavior, error-rate
      ceiling, soak leak tolerance, recovery objectives. (p95/RSS/
      cancellation thresholds already exist — fill the rest.)
I6-62 soak leak baselines: compare start/end RSS, fds, temp files,
      threads/tasks, native processes, model instances, queue entries,
      DB/session handles; bounded deltas, not RSS alone.
```

### Cross-cutting additions

```text
ENV-01 semantic clock/locale freeze for product campaigns: timezone,
      locale, Unicode normalization, date normalization, test clock,
      seed — recorded in campaign environment authorities.
ADM-01 consumer-admission.next.json: production activation is a new
      authority binding provider authority + formats/languages + runtime
      profile + package + product compatibility + release readiness.
      I3/I4/I4A stay historically true forever.
SEAL-01 document-intelligence-development-freeze-set.v2.json: references
      (not rewrites) v1; binds I5 + I6 sections, profileAuthorities, and
      crossChecks {old default unchanged, I5/I6 candidates never silently
      activated, deferred capabilities accounted, no stale proof deps}.
      No provider execution during reconciliation.
```

## 6. Corrected execution sequence

```text
Phase A  closure/tooling foundation (P0, RUN-*, PROF-*, PROTO-*, DB-*)
         cheap/static checks only
Phase B  remaining I3/I4/I4A implementation fixes — no campaigns
Phase C  I5-01..41 complete implementation (candidate only)
Phase D  I6-01..62 complete implementation (candidate profile only)
Phase E  implementation reconciliation: typecheck, lint, schema
         validation, generated-file checks, material-scope validation,
         dependency-graph + leaf-inventory validation, profile catalog
         projections, migration consistency, git diff --check
         → emit implementation-lock.v1.json (last feature-change point)
Phase F  verification epoch:
   F1 I3 impacted leaves → freeze
   F2 I4 campaign on final schema → freeze
   F3 I4A freshness reconciliation, stale leaves only → freeze
   F4 freeze-set.v1 (already sealed; re-assert against final tree)
   F5 I5 qualification (no default-authority change) → freeze
   F6 I6 functional qualification → fix affected leaves only
   F7 I6 load/soak/chaos/resource-pressure — LAST expensive tests
   F8 I6 strict reconciliation → freeze
   F9 development-freeze-set.v2 — no expensive tests
```

## 7. Reuse rule

```text
closed leaf + unchanged declared dependencies = reuse
```

Implementing I6 XLSX does not invalidate I3 GLiNER evaluation, I4 browser
authorization, or I5 calibration evidence unless the proof graph shows a
real dependency. I5 candidate machinery is outside I3/I4 material scopes.

## 8. Current-state reconciliation (2026-09-21)

Already true and preserved by this plan:

- `freeze-set.v1` sealed over I3/I4/I4A; additive material scopes and
  proof-graph `ownsExcludes` already carve I5/I6 additions out of sealed
  fingerprints — the mechanism this plan formalizes as PROF-*.
- I5 implementation committed (`learning/`, `verify_increment5.py`,
  strict receipt present). I6 implementation committed; functional
  qualification partially run; unqualified surfaces remain DENIED.
- `evaluation/increment6/acceptance.yaml` exists (CANDIDATE) — I6-61
  completes it before measured operational runs.
- `BoundedScheduler.max_tenant_share`, office archive limits in
  `limits.py`, and the fallback contract are partial implementations of
  I6-56/I6-49/I6-57 — the added tasks complete them.

Open work added by this revision: LOCK-01, PROF-01..04, PROTO-01..04,
DB-01..05, I5-34..41, I6-49..62, RUN-01..07, ENV-01, ADM-01, SEAL-01.

## 9. Implementation-epoch closure (commit 6f9a5e84a1)

Phases A–E are complete as of the implementation commit. Delivered:
P0 invalidation/tooling, PROF-01..04 (`profiles/default.yaml`,
`increment5-candidate.yaml`, `increment6-candidate.yaml`,
`check_default_catalog_stability.py`), PROTO-01..04 (`contracts/schemas/v1/`,
`contracts/fixtures/i3-canonical/`, `contracts/protocol-extensions.v1.md`,
client capability-version negotiation), DB-01..05 (additive migrations +
`database-schema-compatibility.json`, learning persistence declared
FILE_AUTHORITY with tenant partitioning), I5-34..41 (tenant-scoped
learning v2 manifests, controlled export, revocation propagation,
candidate reproducibility), I6-49..62 (hostile-input preflight, scheduler
fairness/deadline admission, retry-vs-fallback, language resolution,
office projection, observability cardinality, acceptance thresholds,
leak baselines), RUN-01..07 (`evaluation/runner_harness.py`), ENV-01
(`evaluation/semantic-environment.v1.yaml`).

Phase E reconciliation results: pytest 549 passed / 57 opt-in skipped /
2 expected STALE (sealed-material fingerprint drift by design — the
affected leaves re-qualify in F3); `check_material_scopes` PASS,
`check_proof_graph check` PASS, `check_capability_registry` PASS,
`check_default_catalog_stability` PASS, `check_observability_cardinality`
PASS, `verify_increment5` PASS, `verify_increment6` fails only on the two
expected sealed-material drifts (provider semantics + parser routing),
required inventory regenerated DECLARED, `git diff --check` clean.

IMPLEMENTATION_COMPLETE emitted:
`docs/evidence/document-intelligence-implementation-lock.v1.json`
(lockFingerprint `sha256:4de8411b275fdef6da61bdeccaf5921bd1676aa4d80967f98f047b0128644dd9`).
The post-lock policy of section 2 now applies: only fixes demonstrated by
verification failures may change bound material, scoped by the proof
graph. ADM-01 and SEAL-01 remain open for the verification epoch.
