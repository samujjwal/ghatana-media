# FLEURS source authorization request — deferred optional workflow

> **Current disposition (2026-11-03): DEFERRED_NON_BLOCKING. Do not send this request or download/open FLEURS audio for the current phase.** The active English/Nepali benchmark candidate is Common Voice v27; the owner confirms MDC access/terms are complete, local archives are present, and the restricted 24-per-locale pilot manifest is prepared privately. Real inference remains separately NOT_ADMITTED pending model/export-rights, independent reference, and host evidence. Hindi is deferred. See the [current corpus decision](MEDIA-ASR-CORPUS-DISPOSITION-2026-11-03.md).

This remains a future-only request draft and workflow aid. It is not an authorization, legal opinion, accepted dataset record, or inference admission. Reopen it only after a future decision explicitly selects FLEURS.

## Future step 1 — If FLEURS is selected later, ask the publisher for the authorization route and speaker metadata

Open a new discussion on the [Google FLEURS dataset page](https://huggingface.co/datasets/google/fleurs/discussions). Keep this first public message free of clip IDs, hashes, local paths, credentials, or personal data. Ask the maintainers to identify an authorized private contact if exact subset details should not be posted publicly.

**Title**

`Request: bounded offline ASR evaluation authorization and speaker-cluster provenance for English and Nepali FLEURS`

**Message**

> We are preparing a bounded, local-only ASR quality evaluation of Google FLEURS. Could the authorized dataset rights/privacy owner confirm the correct process and provide an authoritative record for this proposed scope?
>
> - Dataset revision: `70bb2e84b976b7e960aa89f1c648e09c59f894dd`.
> - Configurations: English `en_us` and Nepali `ne_np` only. Hindi is deferred.
> - Proposed holdout split: `dev`; please confirm that this is the correct pinned split or specify the intended split.
> - Purpose: internal evaluation of an offline ASR model for recognition quality. No training, speaker identification, voice matching or cloning, external-provider processing, or corpus rehosting.
> - Proposed handling: audio deleted after each run and within 24 hours after an interrupted run; per-clip references and predictions held in memory only; restricted run manifest and aggregate WER/CER retained for 90 days, then deleted.
>
> Before selecting or opening audio, we need to know whether the source owner can document the privacy/consent or other recording-use basis applicable to this purpose, the allowed use and retention conditions, and the required attribution. We also need source-backed pseudonymous speaker-cluster references for selected clips so we can verify the registered speaker-disjoint quality gate without attempting to identify anyone. The current public schema does not expose individual speaker IDs. If the source cannot provide cluster evidence, please confirm that and advise whether an alternative official partition or source-backed method exists.
>
> If this use requires a private request or a different rights owner, please point us to that process. We can provide the exact locale, split, clip IDs, and audio hashes through an approved private channel after the selection procedure is agreed. This inquiry alone is not a request to download or process audio.

## Future step 2 — Wait for an authoritative response

Save the discussion URL and response date. A public maintainer reply is useful provenance, but it is not sufficient unless it comes from an authorized source and answers the exact use, privacy basis, split, and retention questions. The pinned card currently advertises CC-BY-4.0; the Creative Commons deed says that other rights, including privacy or publicity rights, may still limit intended use. The card also says train speakers differ from dev/test speakers, but that statement does not identify speaker clusters for individual clips.

The [existing FLEURS speaker-ID discussion](https://huggingface.co/datasets/google/fleurs/discussions/7) records a Google maintainer response that they had no plans to release individual speaker IDs. Request any later source-backed pseudonymous cluster mapping explicitly; do not derive clusters by comparing voices or invent them. If none can be supplied, leave FLEURS qualification blocked at the speaker-cluster gate.

## Future step 3 — Only if the source confirms a viable route, request exact-subset approval

After the source owner confirms the split and a lawful metadata path, create the proposed bounded selection from metadata only. Do not download or open selected audio yet. Ask the source owner either to provide official per-clip audio hashes or to authorize a bounded, one-time retrieval solely to calculate hashes for the proposed IDs. Do not infer during this step. Keep the exact clip list and digests in the access-controlled local manifest; do not post them publicly. Before inference, obtain a final source record covering the exact list and hashes and record:

- revision and exact locale configurations;
- exact split and clip IDs, with audio SHA-256 digests;
- privacy/consent or other source-backed recording-use basis;
- allowed offline ASR evaluation purpose and prohibited uses;
- permitted processing location and deletion/retention terms;
- attribution text and change-notice requirements;
- source-backed speaker-cluster references, or an explicit statement that they are unavailable.

If the source permits retrieval for digesting, fetch only the approved clips, compute SHA-256, verify the byte and duration caps, then submit the digests privately for the final record. If that limited retrieval is not explicitly authorized, do not access the audio to calculate hashes.

If the publisher cannot authorize the exact subset or supply the evidence required by a future FLEURS-specific quality gate, do not run real FLEURS inference. The owner has reported MDC access and terms complete for the Common Voice v27 English and Nepali archives already present locally; the separate Common Voice profile records that as owner-confirmed but not independently verified. Follow the Common Voice path for current English/Nepali benchmark preparation. A Common Voice result is labeled as Common Voice and does not create a FLEURS result or auto-accept an original Wave 2 row. Continue synthetic FLEURS code-path checks only if needed and prepare a separately approved app-domain evaluation set.

## Future step 4 — Record model and app-quality evidence separately

Dataset permission does not admit a model. Before a real evaluation, record the selected model/export license or provider terms, exact version and artifact digests, English/Nepali support and limitations, and intended deployment host/runtime. The current Whisper Tiny entry is review-only; no production model or host is selected in this record.

For production readiness, collect a separate approved app-domain set with independently reviewed references, held-out consenting participants represented by random study IDs, representative accents/channels/noise/code-switching, pre-registered WER/CER and operational thresholds, and measurements from the intended production host. FLEURS and Common Voice results remain separate benchmark evidence.

## Future step 5 — Bring back non-secret evidence if FLEURS is reopened

Share only:

- FLEURS discussion URL, response date, and the source owner's non-secret answer or authorization-record reference;
- whether the source confirmed `dev`, and whether it can provide source-backed speaker clusters for `en_us` and `ne_np`;
- if an exact subset is approved, the approved revision/config/split and restricted local manifest reference containing selected clip IDs and audio hashes;
- the model/export terms or license URL, exact model version, artifact SHA-256 digests, locale support, and intended host/runtime;
- the internal approval reference and app-domain evaluation plan when available;
- the approved local dataset path when it is time to perform bounded, offline evaluation.

Do not share passwords, MDC/Hugging Face API keys, or public links to the local archive/clip manifest.

## Current disposition

- Active locale scope: English and Nepali; Hindi deferred.
- FLEURS phase disposition: `DEFERRED_NON_BLOCKING`; no authorization request, download, or inference is needed now.
- FLEURS revision: pinned, but exact clips and split confirmation are not recorded.
- Source authorization: not received or verified.
- Speaker-cluster evidence: not available in the pinned public schema; source response required.
- Model/production host: not selected/pinned.
- Real FLEURS inference: `NOT_ADMITTED`.
- Existing FLEURS-specific results and original Wave 2 acceptance statuses are unchanged.
