# Increment 6 — Production Breadth & Release Readiness

Increment 6 extends qualified production breadth, hardens runtime resilience,
and prepares deployment + external certification. It never re-opens the frozen
Increment-3 contracts, the sealed Increment-4 product surface, or the
Increment-5 learning authority it consumes.

The candidate profile is `increment6-candidate`; it is structurally isolated from
`default`, `increment4a`, and the frozen I3/I4/I4A material authorities. Candidate
qualification creates a new immutable authority and consumer admission; it never
silently changes canonical routing, provider registration, model selection, or
historical admissions.

## Non-negotiables

```text
0 scanned/hybrid ambiguity              — every PDF classified: text-native / scanned / hybrid, with provenance
0 silent fallback                       — every provider fallback is explicit, contract-bound, and recorded
0 unbounded runtime pressure            — scheduler, residency, memory, and temp-space are bounded and attested
0 unqualified capability admission      — I6 capabilities stay DENIED until qualified under increment6 profile
0 release claims without evidence       — the release-readiness manifest binds gate receipts, not intentions
0 deployment rollback by improvisation  — rollback re-selects an earlier qualified authority revision
0 vendor-version ambiguity              — SBOM + offline bundle pin every resolved asset by digest
0 mutable qualification inputs          — every campaign carries CampaignGuard material/network/cache authority
```

## Surfaces

```text
routing/scanned-pdf.v1.yaml            scanned-PDF classification + provenance policy
src/document_intelligence/scanned/     page-classification + hybrid provenance (new, additive)
src/document_intelligence/runtime/     scheduler, model residency, memory pressure, drain,
                                       crash recovery, temp-space, asset verification (new, additive)
evaluation/increment6/                 breadth corpora, qualification authority, campaign runners
evaluation/increment6/runners/         load, soak, chaos runners + performance evidence schema
deployment/                            offline bundle, reproducible packaging, SBOM,
                                       deployment gates, activation manifest, operational envelope
release/                               release-readiness manifest + external-certification package
scripts/verify_increment6.py           strict reconciler
capabilities/document-intelligence-capabilities.yaml
                                       increment6 entries are NOT_QUALIFIED/DENIED until the
                                       I6 functional qualification wave promotes them

The worker-side protocol authority pass is documented in
`docs/INCREMENT-6-PROTOCOL-AUTHORITY.md`. It maps I6-03/04/05/06 to the
frozen v1 schema set, canonical I3 replay, additive/versioned extensions, and
provider-catalog negotiation. The strict reconciler executes those checks and
also rejects any PASS projection for an absent fixture-dependent lane.
```

## Profiles

- `increment4a` — the frozen qualified profile; untouched by I6.
- `increment6` — experimental profile admitting I6 breadth for qualification;
  carries explicit `consumerAdmission: DENIED` for every unqualified surface.

## Consolidated implementation boundary

The implementation boundary includes the following additional safeguards and
capability dispositions:

```text
hybrid PDF classification/routing preserves per-page and provider provenance
DOCX/PPTX/XLSX projections are provider-neutral and reject unsupported constructs
OOXML/PDF/image inputs are content-sniffed, bounded, encrypted/active content is
handled deterministically, and native-provider faults are contained
retry and fallback are distinct; both share the original deadline and attempt lineage
shutdown drains/cancels bounded work; restart never resurrects stale inference output
readiness validates immutable authority, assets, providers, and admission
metrics use bounded non-sensitive labels; diagnostics never contain source content
offline qualification proves startup and inference with egress disabled
development canary/rollback mechanisms are tested; actual production traffic remains release activation
```

Hindi and Marathi OCR are active I6 capability work. Hindi/Marathi schema-guided
extraction and scanned-table reconstruction remain explicitly deferred/unsupported
unless a separately owned requirement reopens them. Tesseract fallback is only
admitted where the retained I4A capability authority qualifies it; otherwise the
capability remains deferred or superseded.

## Sequencing (from program authority — `docs/PROGRAM.md`)

1. Functional qualification of all non-deferred required I6 features under the experimental profile.
2. Only after functionality is stable: load, soak, chaos, recovery campaigns.
3. Strict reconciliation; development completion.
4. Release activation stays a separate, later act.

## Execution status (verification wave)

- **Functional qualification**: `evaluation/increment6/run_campaign.py` run
  `20260921T223921Z-48ef0d5e` — scanned-pdf classification lane and
  hybrid-provenance lane executed against declared page facts (the classifier
  contract input): all 8 capabilities QUALIFIED, classification accuracy and
  provenance completeness at threshold. Scanned-table regression lane: every
  fixture held `UNSUPPORTED_BY_DESIGN` (capability registry + fallback-contract
  rejection). Office / hi-mr / complex-layout lanes remain `NOT_RUN` — fixture
  binaries are `DECLARED_NOT_PRESENT`; no lane was falsified. The required lane
  list is unchanged, but the binary-dependent capability dimensions are now
  explicitly `DEFERRED_TO_FUTURE_RELEASE` with a fixture-availability revisit
  trigger. Their `NOT_RUN` observations remain retained evidence and are not
  promoted to PASS. The scanned-PDF and hybrid-provenance lanes remain required
  because their qualification input is the declared page-facts contract rather
  than an absent binary; scanned-table remains `UNSUPPORTED_BY_DESIGN`.
- **Hindi/Marathi schema extraction**: remains candidate-only and denied. Its
  worker capability authority now records `DEFERRED_TO_RELEASE_READINESS` with
  an external-certification release-readiness gate, matching the cross-repo
  capability authority; no consumer admission is widened.
- **Load/soak/chaos**: `load-001`, `soak-001`, `chaos-001` performance-evidence
  artifacts under `evaluation/increment6/results/` (deterministic given seed,
  schema-valid, fingerprint-verified).
- **Release readiness**: all six deployment gates PASS;
  `release/readiness/readiness-manifest.v1.json` reports READY for the admitted
  capability set (unqualified lanes remain `DENIED`).
- **Strict reconciliation**: the protocol checks and sealed I4A fingerprint
  reconciliation are executable, but `scripts/verify_increment6.py --strict`
  remains blocked while office/OCR/extraction/complex-layout fixture binaries
  are absent. Those lanes are intentionally `DEFERRED_TO_FUTURE_RELEASE` with
  `NOT_RUN` evidence and cannot be reported as PASS.
- **Development completion**: the implementation boundary is complete for the
  candidate profile. The strict reconciler remains read-only; release activation,
  real canary traffic, commercial activation, and external certification remain
  separate authorities. Functional, load, soak, and chaos evidence may be reused
  only through native receipts and exact proof identity; an actual material or
  dependency change reopens only the affected native leaves.
