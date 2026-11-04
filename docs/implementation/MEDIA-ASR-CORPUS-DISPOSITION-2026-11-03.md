# ASR corpus disposition — 2026-11-03

> **Current owner decision for this phase:** FLEURS is **DEFERRED_NON_BLOCKING**. Do not send an authorization request, download/open FLEURS audio, or run FLEURS inference for this phase. This does not change historical results, any original task identity, or an R8/R10 acceptance status.

## Active scope and evaluation route

- Active locales are English (`en`) and Nepali (`ne-NP`). Hindi is deferred from this phase.
- Use Mozilla Common Voice Scripted Speech v27.0 as the current external benchmark candidate, through the existing [Common Voice profile](../../config/qualification/common-voice-v27-asr-alternative.v1.json). The owner confirms MDC access/terms are complete and the English and Nepali archives are present locally. No separate non-secret acceptance receipt has been attached to the repository; this is retained as owner-provided provenance, not represented as independently audited evidence.
- A deterministic 24-clip-per-locale Common Voice v27 official-test pilot manifest has been prepared from the local English and Nepali archives. Clip IDs, audio hashes, and local archive hashes remain only in the owner-only metadata root under the 90-day retention policy; none are checked in or printed. The full compressed archives were streamed and locally hashed; selected audio was hashed without extraction or decoding.
- Common Voice real inference remains **NOT_ADMITTED**. Exact Whisper artifact/export rights, independent reference review, and execution-host qualification remain unresolved. MDC access/terms and manifest preparation are no longer blockers; resolve the remaining gates before inference.
- Production readiness still needs a separately approved, consented app-domain evaluation set with independently reviewed references, held-out participants, representative app conditions, pre-registered quality limits, and measurements on the intended host. Common Voice is benchmark evidence; it does not replace app-domain evidence.
- Synthetic fixtures remain available for deterministic code-path, safety, and robustness tests. They do not establish real model quality.

## FLEURS disposition

FLEURS adds a useful standardized multilingual benchmark, but it is not needed to advance this phase's English/Nepali evaluation path. Its public CC-BY-4.0 label does not itself provide the exact source-backed privacy, permitted-purpose, retention, split, and speaker-cluster evidence previously sought for the proposed subset. Deferring it avoids an unnecessary authorization/download workstream while the alternative route is prepared.

No FLEURS source request or download is required now, and FLEURS is not a prerequisite for this phase's app readiness. If a future phase elects to publish FLEURS-specific results, reopen the separate authorization workflow and obtain the required exact-subset evidence before accessing or processing audio. Existing FLEURS evaluator code and historical observations remain reference material only.

## Acceptance and reporting boundaries

- The original Wave 2 denominator and last recorded status remain **58 = 22 locally verified + 30 partial + 6 owner-external**. No task, including STT-10/12 or G07, is accepted by this disposition.
- Use the lawful alternative already permitted by the G07 action map for current English/Nepali evidence. The owner confirms MDC access/terms are complete; apply the profile's privacy, purpose, and retention rules. The restricted test manifest is prepared; complete model-rights, gold/reference, and host review before any inference. If that evidence is unavailable or does not meet the original quality criteria, report the quality gate as open; FLEURS itself remains deferred.
- Label any result with its actual corpus and scope. A Common Voice result is not a FLEURS result, does not inherit FLEURS thresholds, and does not establish production quality by itself.
- Hindi-specific evaluation remains deferred. Historical en/hi/ne reports and original denominators remain unchanged.

## Current and future handling

Follow the retention and field-minimization rules in the Common Voice profile. Do not identify speakers, infer identities, clone voices, train on the corpus, send audio to an external provider, or re-host the corpus. Keep per-clip references and predictions in memory and apply the profile's bounded cleanup rules to any later authorized run.
