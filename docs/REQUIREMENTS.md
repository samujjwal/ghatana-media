# Product requirements

This page is an index. The canonical requirements and their product meaning are authored in [PDP-0 Product Truth](../.product-experience/pdp-0-product-truth/requirements.yaml). Related goals, capabilities, actors, channel applicability, journeys, and quality boundaries live beside that registry in the same phase directory.

The [PDP source index](../.product-experience/README.md) defines ownership across PDP-0 through PDP-3. The source-pinned [PDP-0 development status](implementation/pdp-0-phase-dev-status.json) reports definition progress; it does not add or change requirements.

Media has no released application. These product definitions describe intended behavior and do not claim that a capability is implemented, available, qualified, accepted, or released. Add requirement meaning only to the canonical PDP-0 sources and keep this page as navigation.

## Current required capabilities

For backend Wave 2, use the [canonical execution plan](implementation/MEDIA-BACKEND-MODALITY-WAVE2-EXECUTION.md): STT-01–12, TTS-01–12, VIS-01–12, MM-01–12 and OBS-01–10. Its task rows bind existing PDP capability IDs to implementation and executable acceptance; its 99 capability memberships and 43 RPC mappings retain the original scope. The [R7 directive](implementation/MEDIA-WAVE2-OWNER-IMPLEMENTATION-DIRECTIVE-2026-10-27.md) orders the remaining work, with the [structured schedule](implementation/MEDIA-WAVE2-R7-EXECUTION-SCHEDULE.json) as a selection aid. Neither this index nor the schedule is another requirements/status ledger.

## Current-state gaps

The canonical plan records which original criteria still lack implementation or proof. Inspect the relevant row and current source before relying on a historical result. Required work includes trusted source/rights integration, real provider outputs and model/voice/corpus qualification, durable attempt/result readback, source-clock composition, native resource limits, public Data Cloud/Document Intelligence integration and measured modality quality/performance. A typed `NOT_ADMITTED` or passing fixture proves the guarded code path only; it does not satisfy an intended positive capability.

Repairable documentation drift belongs in the existing module guide or owning source projection: correct source paths, configuration usage and links from actual code/manifests, without changing product meaning or task acceptance. See the [API inventory](README.md#api--config--contracts--manifest-backed-inventory) and [evidence requirements](EVIDENCE.md).

## Unsupported-by-design behavior

Media does not own generic OCR/model execution, platform policy, Data Cloud projection mechanics or a second job/outbox writer. Consult [BOUNDARY](../BOUNDARY.md) before extending those boundaries. Synthetic model output, caller-supplied consent as authority, replay after an unknown effect, and silent cross-tenant reuse cannot serve as supported alternatives. These exclusions do not dispose of the required Media capability; it must integrate the owning public contract or remain explicitly unavailable.

## Hard blockers requiring human decision or external evidence

Exact voice/model/corpus rights, biometric consent, non-inferable product-semantic conflicts, production activation and operational cutover require authentic evidence from their owners. The Wave 2 plan and R7 directive identify the relevant handoffs. These bound the affected action and completion claim; independent implementation and isolated tests continue under [AGENTS.md](../AGENTS.md).

## Improvement backlog

Keep new optional capabilities outside the current repair slice unless current requirements, security, correctness, operability or reproducibility require them. Record new product meaning in its owning PDP source and link any approved execution work from the canonical Build plan. This review adds no new capability or task ID; incomplete original Wave 2 criteria remain current-state gaps, not optional backlog.
