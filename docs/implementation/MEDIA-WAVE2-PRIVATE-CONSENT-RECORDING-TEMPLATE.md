# Wave 2 — private source recording, voice and biometric permission checklist

**Template only. Do not fill or sign inside the public Media repository.** This is a checklist for independently reviewed permissions, not a complete legal contract and not an alternative to Media's current consent/policy authority. Store actual participant identity, signature, contact, media, legal documentation and any consent proofs only in the approved restricted rights vault; the public repository may record only an opaque reference and SHA-256 digest.

## Identity and source

- Identity of consenting competent adult and authenticated signature method (private).
- Name and contact for rights/consent custodian (private).
- Who captured, owns, composed or licensed the exact sound, speech, video, images, presentation, music, fonts and background content (separate owners/grants if necessary).
- Immutable source media artifact ID, version, SHA-256, capture time and location/retention classification; any original speaker/face/profile identity binding belongs in the private authority.
- Purpose and exact Media operation(s), consumer organization(s), scope and product/environment (local evaluation vs wider use) and allowed regions/providers.

## Separately opt in; all unchecked by default

- [ ] Ordinary audio transcription and translation/word timing for a named source.
- [ ] Internal display/caption/render of that content (not necessarily redistribution).
- [ ] Third-party model processing and any provider retention/region terms.
- [ ] Anonymous diarization / segmentation (without speaker identification).
- [ ] Voice embedding, speaker identification or verification (specific biometric purpose).
- [ ] Recording/training of a custom voice model and generated voice likeness.
- [ ] Voice cloning or speech conversion for specifically named future content.
- [ ] Face embedding, facial identity matching or gaze/emotion interpretation (specific biometric purpose).
- [ ] Release/publication of recordings, transcripts, generated speech, media renders or model-derived data.
- [ ] Model training/fine-tuning, entirely separate from one-time inference.

## Limitations and termination

- Effective from/until; maximum raw/derived/model/embedding retention; data residency and region; encryption and minimum access; subprocessors and cloud egress.
- Right to withdraw and how to make the request; how Media will revoke future dispatch/replay, erase where legally required, and notify any subprocessors. Describe limits on undoing prior authorized publication.
- Source-owner warranty for copyright/recording rights and any third-party licences; never state a participant owns third-party music or images merely because they uploaded them.
- Independent rights/privacy review result (private) with explicit allowed scopes and constraints, accepted signature and signed timestamp.
- Separate revocable consent authority record and exact policy version for MediaConsentAuthority and Shared PolicyEngine; the authenticated server must check current status **at each effect and retry**.

## Public-safe receipt only

Store `{sourceVersionDigest, opaqueRightsDecisionRef, opaqueConsentDecisionRef, policyVersion, reviewerKeyId, signatureDigest, authorizedPurposes, expiresAt, revocationScope, evaluatedAt}` as redacted metadata if permitted. Do **not** store names, emails, phone numbers, signed PDFs, voiceprints, biometric embeddings, full transcripts, child IDs, or location/health details in version control, test XML, logs, metrics or automated pull requests.

**No human signature means no biometric/clone positive-path authority.** Generic STT of legally usable licensed content, generated synthetic timing fixtures and legitimate third-party model evaluation may proceed under their *own* separate rights and data licenses, without pretending biometric permission exists.