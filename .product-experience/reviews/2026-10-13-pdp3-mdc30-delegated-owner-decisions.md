# PDP-3 MDC-30 — delegated owner decisions (Media Discovery)

**Decision:** `MEDIA-PDP3-MDC30-OWNER-DIRECTIONS-2026-10-13` · **Source:** `samujjwal/ghatana-media@58fb822179f782175b6025d37f63a631f4fe66a6` · **PDP-3 observed fingerprint:** `sha256:e48e639bfe200c2a715d55bde3aa33f064410e80e1e418d793421876d53ccac9`  
**Machine-readable instruction:** [30 journeys and 14 consequential steps](../../docs/implementation/observations/media-discovery-pdp3-owner-binding-directions-2026-10-13.json). **Disposition:** **APPROVED WITH IMPLEMENTATION CORRECTIONS**, not completed PDP-3.

The repository user delegated Media product, engineering, architecture, specialist-design and internal reviewer choices to this assistant. This document transparently records **delegated AI-assisted internal decisions**, not an independent human's signature, legal/security/accessibility professional attestation, another repo's public-contract owner acceptance, test evidence, Lifecycle receipt, Build entry or Delivery authorization.

## Decisions now made; no implementer owner-choice work remains for unchanged material

**MD30-01 — APPROVED journey channel intent.** Preserve intended channel sets for all 30 journeys in the machine packet. The 24 proposed journey declarations remain scope, not proof of equivalence. J-01/J-02 need common binding-state; J-03 web/CLI/gRPC/SDK and J-20 web/CLI derive from their existing `channelEquivalents`; J-29/J-30 already use `channelRefs`. Do not force duplicate authority, invent routes/RPCs/commands, or silently remove a target channel to improve the gate.

**MD30-02 — APPROVED architecture.** Add PDP-3 canonical **binding edges only** under `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml`; per-journey contracts still own their meaning. Each intended channel must link exact P1 operation/state/observation semantics and P2 interface grammar, authority, typed request/result/error, version, finality, denied/unknown/recovery, accessibility (GUI) or machine equivalents (headless). `NOT_ADMITTED` is allowed only when logical product behavior is fully defined, not to hide missing source meaning. A CLI fixture is not a production command; a proposal is not a gRPC route.

**MD30-03 — APPROVED 14 exact consequential interpretations.** The packet names each observed journey step, action, P1 operation and semantic finality. Create-project/begin-upload may establish **initial state**, not fake previous transition; cancel is request, not terminal CANCELLED; retry needs fenced/classified prior attempt; delivery requires external ACK; transcript request is not caption finality; session-local caption draft is not immutable registration; immutable caption version is not formal review approval. Implementer must verify **actual** P1 edge/source guard or explicit no-machine-state rationale; no exact transition IDs are falsely approved here.

**MD30-04 — APPROVED integrations PDP-3 applicability.** `media.surface.integrations` is an **applicable contract-only / host-dependent consumer**. Amend `.product-experience/surface-registry.yaml` to include PDP-3 under `applicablePdpArtifacts`, set `TARGET_HOST_CONTRACT_PENDING` with intent/owner/negative/recovery rationale, preserve `SOURCE_ONLY`, `PENDING`, existing service registry and the 17-consumer denominator. J-09/14/22/25/26/28 require exact integration binding. This approves internal Media product meaning, **not** a provider's contract or an admitted host.

**MD30-05 — APPROVED external currentness policy.** Only named external contract **content bytes** and ownership edges are material to Media meaning. Repository SHA or dirty/untracked status alone is diagnostic. Reconcile live named files against `.product-experience/source-manifest.yaml`; compare actual digests before claiming unchanged external inputs. A real changed external contract maps to exact affected Media requirements and review, not automatic reopening of unrelated already-closed units. No external repo modification is authorized.

**MD30-06 — APPROVED consistency and phase gates.** Keep 54/55 transition records with their precise source-only dispositions; do not conflate 54 unbound P1 transitions with 54 missing user commands. Existing 118 null state disposition classifications (33 passive, 70 read-only, 14 consequential, 1 external) stay as a bounded review baseline. Validate the 14 separately. Where a registry edit changes PDP-0/1/2 material, recapture exactly affected cells/dependents before current PDP-3 exit. Preserve historical exits.

**MD30-07 — APPROVED Explorer and downstream outcomes.** After real MDC-30 definition work passes, implement the read-only Explorer with root→composite→physical→consumer navigation, all four PDP source authorities, GUI design tokens/components/screens and headless API/gRPC/SDK/CLI/Agent/Event contracts, deterministic fixtures and truthfully labeled previews/nonadmissions. Run actual browser tests (MDC-31), publish current PDP-3 exit (MDC-32), then 200-cell Discovery barrier (MDC-40) and only then Build handoff (MDC-41). Native PDP closure remains a separate later lane.

## Precise work ownership

- **Media experience owner:** MDC30-C-01…C-30 channel edges; MDC30-S-01…S-14 guarded state/effect mappings; tests and exact new-source review.
- **Media runtime/integration owner:** apply decided PDP-3 integration consumer classification, check service/journey crosswalk; external owner acceptance stays separate.
- **Media source-manifest owner:** recapture named external contract file digests and classify real change; do not claim to know dirty sibling bytes from GitHub alone.
- **Explorer/design owner:** after MDC-30 passes, execute real MDC-31 browser/design/source UX acceptance, not a design-decision discussion.
- **Media status owner:** publish new immutable MDC-30, PDP-3, Discovery and Build-handoff records only after their actual gates.

**Current status:** PDP-0/1/2 have source-current phase exits at the reviewed baseline; PDP-3 MDC-30 still OPEN, current PDP-3 DEV_COMPLETE not established; Discovery FAIL; Build NOT_ENTERED; Lifecycle PDP closure NOT_ENTERED; Delivery BLOCKED. The previous 19/19 MDC-30 focused test result and 8/8 regression are *historical observed results*, not test runs from this approval pass.
