# Production dubbing orchestration

`DubbingOrchestrator` coordinates source-rights checks, translation, voice authorization, synthesis, and forced alignment through injected ports. It supplies no translation, voice, synthesis, or alignment implementation. Missing or unadmitted capabilities return typed `UNAVAILABLE`; provider failures or mismatched effect bindings remain `OUTCOME_UNKNOWN`.

## Binding and authorization

Each request binds tenant and request identity, an immutable source artifact/version, an exact transcript revision, source and target BCP-47 locales, source clock/tick rate/duration, and immutable voice identity/version. Translation, per-segment audio, and alignment responses must echo the matching source/transcript/locale/voice/timing scope. Audio checksums are validated, and aligned intervals must remain inside the exact source transcript segment interval.

The injected rights/consent authority must separately allow source-derived translation and synthesis for the selected voice and purpose. The orchestrator checks both decisions before provider dispatch and rechecks them before synthesis, alignment, and final result exposure. Denial, revocation, and unavailable authority produce no completed output claim. A translation that occurred before a later denial remains recorded as a partial effect in the typed result.

## Limits and qualification

The module accepts at most 4,096 transcript segments, 4 million aggregate text code points, 16 MiB per audio segment, and 256 MiB total returned audio. It does not establish language support, voice likeness rights, translation quality, intelligibility, lip timing quality, provider admission, or production readiness. Current candidate records do not admit a translation or forced-alignment provider; TTS voice and rights admission remain owner-controlled external requirements. Tests use local fake ports only.
