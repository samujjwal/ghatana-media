# Media Recorder/Studio PDP-0–2 surface successor — authored source and remaining validation

**Source cut for controlled change:** `main@0c572079100d6cd784ba4a9cc62b87c1f3e7e707`.  
**Macro stage:** DISCOVERY. **Affected phase progression:** PDP-0 → PDP-1 → PDP-2, then mandatory PDP-3 successor.  
**Scope:** Media's existing 26 physical candidates, 6 preexisting semantic compositions, one repository root, 17 preexisting consumer surfaces, plus exactly four new source-only logical consumers and one cross-child semantic composition.  
**Owner instruction:** the user explicitly requested authored Media PDP-0–2 surface updates and any necessary new surfaces. This authorizes source definition work and recorded design dispositions only; it does not impersonate independent human, legal, accessibility, licensed provider or film approvals.  
**Source status:** new PDP-0/PDP-1/PDP-2 definition contracts authored, **not independently validated as `DEV_COMPLETE`** at the successor cut; prior `DEV_COMPLETE` records remain true at their historical material cuts and are not overwritten. Media runtime Build is not authorized.

## Decision: one authoritative product, additional logical surfaces, zero phantom code

The new product surface identities are actual source-registered consumer/contract surfaces, not new physical package trees or deployed applications. Record them in the canonical `.product-experience/surface-registry.yaml` and strict physical/composite crosswalk. Existing physical manifests are reused for definition ownership. Physical Recorder engine, capture agent, Studio host and interactive player will only be implemented after Build admission and independent public-package qualification. `ghatana/services/media` remains the current canonical executable writer until the separate MIG-04 cutover.

| New identity | Bounded intent | Existing physical owner candidates | Stage |
| --- | --- | --- | --- |
| `media.surface.experience-recorder` | Governed unattended plan, capture, scene QA, approval and publishing orchestration | Launcher, runtime contracts, Media client | Source-only |
| `media.surface.capture-agent` | Explicit source adapter: browser/desktop/mobile/terminal/API/gRPC/camera/media-file, with delegated actor, redaction and clock | Media types, client, runtime contracts | Source-only; no agent binary yet |
| `media.surface.presentation-studio` | Full manual/assisted multi-track editor over one MediaProject revision | Media UI, types and client | Host-dependent, source-only |
| `media.surface.interactive-demo-player` | Declarative non-privileged branching/hotspot player with CSP, captions, safe viewer policy | Media UI and types | Host-dependent, source-only |
| `media.composition.experience-recorder-studio` | Joint capture→edit→render→QA→human review→interactive output and delivery | Eight existing physical children | Cross-child source-only obligation |

The composite's `CONTAINS` references are direct physical membership. Its meaning does not copy the leaf definitions; `DEPENDS_ON` is not CONTAINS; reused multi-parent physical leaves are enumerated by the root's `sharedPhysicalMemberships` and counted once.

## Authoritative PDP definitions actually extended

| Phase | Owns | Changed normative records | What is now defined |
| --- | --- | --- | --- |
| **PDP-0** | Product goal/capability, policy, applicability, cross-family requirements | `pdp-0-product-truth/requirements.yaml#ownerDefinedExperienceProductionRequirements`, `profile-semantics.yaml#experienceProductionProfile`, `handoff-contracts.yaml#recorderStudioPdp0ToPdp1SuccessorHandoff`, surface registry and topology | Eight normative requirement groups, four channels/source-bound surfaces, immutable goal and source/version/policy constraints, explicit denial, no privileged product import, AI rights, privacy/O11y and technical-vs-human QA |
| **PDP-1** | Project/revision/source time, typed commands, results, effects, conflicts, lineage and finality | `pdp-1-domain-data/versioning.yaml#experienceProductionRevisionContract`, `action-contracts.yaml#experienceProductionActionOrchestration`, `domain-objects.yaml#ownerDefinedExperienceProductionObjectProjection`, P1 handoff | `ProductionProject` is one typed view of existing MediaProject and ProjectRevision; 7 operation compositions reuse existing canonical owner IDs; two new operational bindings (non-stream capture and changed-scene recapture) remain expressly unadmitted; scene/manual locks and unknown reconciliation defined |
| **PDP-2** | Reusable GUI/headless/CLI/player grammar and accessibility | `pdp-2-design-interface-system/media-editing-grammar.yaml#professionalStudioGrammar`, `interface-grammar.yaml#experienceProductionChannelGrammar`, `accessibility.yaml#experienceProductionAccessibility`, P2 handoff | Studio panels, commands, shared CAS selection, keyboard/numeric timeline parity, typed machine-only results, safe interactive hotspot sandbox and protected status/recovery views; existing templates/layouts/components reused without duplicate primitive tokens |

No new `capabilities[].id`, `domain-objects.objects[].id`, historical `requirements[].id`, PDP-3 journey/screen or transport endpoint was silently minted to make a denominator green. The four new logical surfaces and composite are real **definition surfaces**, not runtime code.

## Complete surface / PDP cell denominator

| Population | Historical | Successor | Disposition |
| --- | ---: | ---: | --- |
| Physical manifest candidates | 26 | 26 | Reuse; do not create phantom code before Build |
| Semantic compositions | 6 | 7 | One new cross-child meaning |
| Repository root | 1 | 1 | Updated unique/containment membership |
| Consumer surfaces | 17 | 21 | Four new logical surface contracts |
| Full four-phase cells | 200 | 220 | No status green by denominator change |
| Targeted PDP-0–2 cells | — | 165 | Phase-local authority and successor status recorded in machine crosswalk |

[Machine-readable 55-surface authority/phase crosswalk](observations/media-recorder-studio-pdp0-2-surface-crosswalk-2026-10-17.json) contains every physical leaf, semantic composition, root and consumer: canonical source binding, affected/unaffected status and PDP-0/1/2/3 attribution. It is a **derived review lens**, not a second editable authority or independent Lifecycle status.

### Status, gates, and required tests

Historical phase status files and immutable evidence remain untouched. Successor PDP-0–2 contracts are authored and require exact-source/current checker tests and owner phase-admission review before `DEV_COMPLETE` can be asserted for the new meaning. PDP-3 is separately incomplete for the new surfaces and may not be skipped. Existing Media closure and publisher readiness are separate, and the existing Gharbatai recorder continues as source until portability/runtime cutover meets its own gates.

**Discovery barrier:** NOT PROVEN PASS. **Media Build lane:** NOT ADMITTED. **PDP acceptance/closure lane:** independently pending. **Delivery gate:** NOT AUTHORIZED. **Next legal phase:** verify and accept affected PDP-0 successor, followed by bounded PDP-1, PDP-2 and complete PDP-3 definition; only after whole-campaign exit can Build begin.

## Remaining-only queue (do not re-open unaffected work)

| Task | Phase | Required completion |
| --- | --- | --- |
| SUCC-01 | PDP-0 | Validate new 4-source applicability and new composition against exact current capability/requirement owner, including negative states and physical host distinction. |
| SUCC-02 | PDP-0 | Recapture source-current phase meaning for changed parent/root and source files; do not overwrite completed historical status or revalidate unaffected leaves. |
| SUCC-03 | PDP-1 | Reconcile capture-source and changed-scene recapture missing owner operation IDs; define closed wire result/error guards at owning operations before any invocation. |
| SUCC-04 | PDP-1 | Verify that all new source/scene/track/overlay/CAS types use existing 39 object identities and exact source clocks without a second project or job store. |
| SUCC-05 | PDP-2 | Check Studio grammar against 31 component families, GUI/CLI existing recipe chains and exact accessible nonvisual parity. Record required design additions at their owner. |
| SUCC-06 | PDP-2 | Run source-based topology/contract, privacy, redaction and interface-negative tests, then exact affected phase successor exits in order. |
| SUCC-07 | PDP-3 | Author source-complete Studio, recorder, player and capture-adapter journeys, screen/step/channel/CLI/API-only surfaces, with Explorer projection; no fake GUIs. |
| SUCC-08 | GATE | Perform full source-current Discovery R7/readmission and required independent review; only then schedule Media Build and publish packages. |

This successor does not replace the existing D01–D10 Discovery finishing queue or W01–W24 Build handoff; it supplies a source-grounded input to their controlling change-impact reconciliation. Independent licensing, real capture/media performance, outside owner authorizations and release are not certified by definition files.

## Additional first-class PDP-0–2 authority bindings

The source-definition extension also binds the four logical surfaces into the **existing** channels and information hierarchy (`pdp-0-product-truth/{applications-channels,information-architecture}.yaml`). No tenth channel, invented route, GUI for machine-only products, or new physical runtime has been introduced.

PDP-1 now has explicit `privacy.yaml#experienceProductionPrivacyTrustContract`, `relationships.yaml#experienceProductionRelationshipProjection` and `states.yaml#experienceProductionStateProjection` sections. All reference the existing **13 relationships**, **11 state machines**, 39 domain object identities and owning Media policy/operations authorities. They do not create second privacy or event engines. PDP-2 `gui/screen-composition-schema.yaml#experienceProductionScreenCompositionRules` binds complete Studio and safe Player layout responsibilities to canonical design components while leaving new PDP-3 screen identity authoring separate.

This work requires a current 55-surface source-currentness observation. The legacy 50-surface R15/R30/R19 review artifacts remain immutable historical evidence, not a PASS for the expanded scope. `resolveMediaPdp0Cells()` defaults to the full successor; `campaignScope: 'historical'` is an explicit historical read-only comparison and must never confer phase admission.
