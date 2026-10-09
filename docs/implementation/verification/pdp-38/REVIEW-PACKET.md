# PDP-0 through PDP-3 independent review request

Mandate: `docs/implementation/EXECUTE-MEDIA-PDP-0-3-38-TASKS.md`. Exactly 38 tasks; no standalone Explorer, deployment, runtime qualification, release or commercial acceptance. This packet requests independent review; it records no approval. The coordinator's owner decisions and subagent tests are implementation inputs, not specialist acceptance.

## Current source and reproducible evidence

Run `node scripts/report-media-pdp-readiness.mjs --verify --write` from Media. `docs/implementation/media-pdp-38-readiness.json` records the source HEAD, source hashes, exact original task criteria, live residual counters and scoped test results. The adjacent P0-04/P1-06/P2-01 logs are local source tests only. Regenerate manifest/projections and Lifecycle source inputs before final review. A review against changed source hashes needs an explicit impact determination or retest.

Review all applicable records in the four `.product-experience/pdp-*` directories, with canonical ownership from `authority-map.yaml`, source IDs from `source-manifest.yaml`, dependency identities from `artifact-identities.yaml` and the published/pinned development contract inputs. Generated candidates are projections of authored authority, not accepted definitions.

## Required reviewers and criteria

| Task | Qualified reviewer | Exact decision scope |
| --- | --- | --- |
| P0-08/P0-010 | Independent product/domain reviewer | All 462 leaves: individual applicability, actor/profile/channel, exact target, input/output units and per-operation bounds. All remaining normative migration claims have a unique current owner or justified supersession. Actor/intent/requirement/outcome measurement crosswalk remains internally consistent. |
| P1-11 | Independent domain/distributed-systems reviewer with security/privacy expertise | Canonical entity identities and immutable lineage; every command/query or factual non-operation disposition; authority at effect boundary; guards, idempotency, stale fencing, unknown outcome, cancel race, retry eligibility, delivery uncertainty and exact wire role/compatibility. |
| P1-09/P1-10 | Scientific/metrology and security/privacy specialists where applicable | Timebase/unit/coordinate conversions, declared precision/loss, cross-tenant denial, revocation, retention/hold, partial erasure, offline stale revision and safe duplicate-effect handling. Source model results must not be called production qualification. |
| P2-08/P2-09 | Independent visual/interaction/accessibility professional | Central grammar, public Shared artifact/export/prop/token/license classification and all applicable 47 compositions. Light/dark/forced colors, reduced motion, keyboard/focus/status, zoom/reflow and actual supported assistive technology observations. Source-selected templates do not imply instance conformance. |
| P3-09/P3-10 | Independent interaction/usability/domain reviewer | 30 journeys/130 ordered steps, 146 actions and 31 scenarios. Actor, object version, authority, legal operation/guard/effect/finality and denial/unknown/recovery branch. Explicit passive/read observations need factual no-transition reasons. All applicable machine channels have deterministic inspectable contracts; no synthetic GUI for machine-only capabilities. |

## Mandatory falsification checks

Reject unresolved or wrong source IDs, swapped actor/tenant, stale version/fingerprint, absent consent or rights, unqualified provider claims, unknown coerced to success/failure, cancellation-requested coerced to cancelled, unsafe retry without prior attempt and budget, unconditional boolean reversibility for conditional effects, invented endpoint/name-based semantic equivalence, skipped applicable screen/action, unsupported no-domain-transition explanation, and absent scenario precondition/oracle. Preserve reviewer disagreements and adverse findings.

Visual/AT review must record actual browser/version, assistive technology/version, viewport/density, zoom, theme/forced colors/reduced motion, locale/RTL where applicable, keyboard path, spoken state/focus/label observations and time-based media controls. Browser smoke/axe/source assertions alone do not establish human review.

## Review response contract

For each decision supply actual person or qualified reviewing organization, expertise/affiliation and independence disclosure; exact phase/tasks/record IDs; commit and source/dependency hashes; methods and environment; findings with severity and evidence; requested changes; retest observations; decision (accepted, changes required, or withheld), precise accepted scope and timestamp. Pending reviewer identities remain absent. Do not sign for a package publisher, legal licensor or Lifecycle issuer.

## Lifecycle owner deliverable

Use `config/closure/media-product-definition/{obligations,phase-program,phase-binding,l02-source-case-links,l03-proof-route-candidates}.json` and `config/closure/consumer.json` as authored inputs. Recompute the current obligation population; do not freeze historical 318/319/344/348 counts after source changes. Admit actual executable cases with criterion-specific positive/negative oracle, registered observer/oracle/provider, proof class, input/dependency vector and permitted immutable artifact distribution. Reject missing/stale/duplicate/shadowed/unauthorized results. Lifecycle alone issues native phase receipts and currentness after semantic and required independent acceptance.

Requests are tracked in Media #4, Shared #234, Lifecycle #1 and Tools #30. The Tools ghost-executable fix is already recorded in Tools #30; it is not a remaining Media implementation predicate. No receipt count is inferred from absent local bindings; authoritative status remains NOT_EVALUATED until queried from the issuer.
