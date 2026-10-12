# Media product examples

This page gives source-traceable journey examples, not runtime recipes. “Complete”
here means the source journey can be followed from its stated input/preconditions
through its intended result and stated exception/recovery intent. It does not mean
the flow is accepted, deployed, or available from a provider. The underlying
journey registry reports 30 contracts and 130 ordered steps, with 120
step-level action references, 95 operation references, and 4 journey contracts
that reference the 31 seeded scenarios. The remaining 26 journeys have no exact
scenario seed reference; semantic acceptance remains pending.

## Status vocabulary

- **Proposal** means the cited PDP-3 journey is source-authored but not accepted.
- **Synthetic fixture** means deterministic fixture data only; it does not
  transfer media, invoke a provider, or establish runtime qualification.
- **Accepted/available** is claimed only when a source explicitly says so. No
  P3-08 example below claims that status.
- **`DEFINITION_ONLY`** describes a definition-level disposition, not runtime
  implementation or qualification. Implementation, license admission,
  qualification, runtime availability, and owner acceptance remain separate
  questions; evidence for one does not establish the others.
- A screen or candidate action is not silently promoted to a step-level action
  or canonical operation. Where a journey leaves `actionRef` or
  `canonicalOperationRef` null, this page preserves that gap.

Sources: [journey registry](../.product-experience/pdp-3-product-experience/journey-registry.yaml),
[scenario fixture registry](../.product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml),
[action registry](../.product-experience/pdp-3-product-experience/action-registry.yaml),
[screen registry](../.product-experience/pdp-3-product-experience/screen-registry.yaml).

## Definition-only example: recover an uncertain transcription job

**Status:** seeded deterministic definition example; no remote request, provider
result, accepted journey oracle, or production channel is claimed.

- **Input and identity:** `media.scenario.job-outcome-unknown` seeds the exact
  synthetic logical job `fixture-transcription-job-unknown` against source
  artifact version `source-v1`. The job and attempt are both
  `OUTCOME_UNKNOWN`; finality is `UNKNOWN`. No result version is present.
- **Constraints and authority:** the fixture records `consentState: ACTIVE` and
  `checkJobOutcome: ALLOWED`. This is local synthetic authority state only; it
  does not supply trusted tenant/principal identity, rights evidence, or a
  production grant. The action must remain unavailable when current scoped
  authority is denied or unknown.
- **Action and channels:** [J-03](../.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml)
  is the selected transcription example; the matching unknown-outcome and
  confirmation seeds are linked to [J-20](../.product-experience/pdp-3-product-experience/journey-contracts/long-running-job-observation-and-recovery.yaml),
  whose `media.action.check-job-outcome` binds to
  `media.operation.action.check-job-outcome`. Its declared channel equivalents
  remain proposal bindings: the CLI projects the same simulation state, while
  HTTP/RPC/SDK transport equivalence is unresolved.
- **Expected effect and provenance:** the fixture action can move the local
  observation to reconciliation for this same job identity. It does not create
  a second request, allocate a new attempt, or create a transcript/caption
  version. The event log is synthetic fixture provenance, not provider or
  lifecycle evidence.
- **Failure and recovery:** if authority or the outcome observation is
  unavailable, retain `UNKNOWN`, preserve the same job ID, and disable
  submission/retry. Only an explicit fixture outcome-check event can classify
  the local example; a remote timeout or absent event is never a no-effect
  proof.
- **Binding gap:** the fixture does not contain a request fingerprint or
  trusted principal and has no accepted result oracle, so this remains a
  definition trace rather than a complete executable machine-channel example.

## Source upload, verification, and caption correction

**Family:** source upload → verify → transcribe/correct. **Status:** J-02 and
J-03 are proposals; J-02 has metadata-only synthetic fixtures, and J-03 is a
selected audio-source proposal. Real byte transfer, provider execution, and the
full video-transcription path are not established.

- **Trace:** [J-02 upload/import/verify](../.product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml)
  orders source selection/import, upload/job observation, and artifact
  inspection. Its terminal step is `media.action.inspect-source`, bound in
  J-02 to `media.operation-slice.inspect-artifact-version`; this reads metadata
  and the time-scoped recorded integrity/lifecycle disposition for one exact
  immutable version. It does not establish current availability, rights,
  consent, retention authority, or permission to process or deliver. PXD-049
  separately defines the required verification gate; the earlier
  `media.action.attach-source-asset` action is not the terminal step.
  [J-03 transcription/correction](../.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml)
  continues through `select-source`, `monitor-transcription`, `review-transcript`,
  `correct-captions`, and `compare-caption-versions`. J-03 names
  `media.action.choose-source` and `media.action.request-transcription` as
  proposal actions. Caption correction is more specifically mapped in J-03 to
  `media.action.correct-caption`, `media.action.align-caption-timing`, and
  `media.action.save-caption-version`. The PDP-1 proposal maps the first two to
  `media.operation.caption-draft-write` and separately maps save to
  `media.operation.caption-version-write`. Save and compare have bounded source
  definitions under PXD-060; runtime admission remains `NOT_ADMITTED`. The
  comparison action binds to `media.operation.caption-version-read`. Draft
  editing remains proposal-only, and no runtime behavior is implied.
- **P3-08 start/identity/authority/channel:** Start with one selected source;
  J-02's exact immutable artifact-version identity and J-03's exact audio source
  version are the contract targets. J-02 requires current scoped authority for
  observation and separately gates verification, rights, consent, retention, and
  processing; J-03 preconditions require current rights/consent/location policy.
  J-02 candidate channels are `media.channel.web`, `media.channel.http-api`,
  and `media.channel.sdk`; J-03 declares a Web surface but no channel binding.
  No literal source, tenant, principal, or job ID is supplied by these examples.
- **P3-08 action/result/evidence:** J-02 ends with exact-version inspection;
  J-03 proposes transcription, draft correction/alignment, save, and compare.
  Result: verified immutable artifact version or a proposed caption version tied
  to its source; caption finality and a committed version ID are not established.
  Uncertainty is explicit for upload/provider outcomes, language/timing, consent,
  and stale source. Caption provenance is proposed; no production provenance
  record is asserted. Preserve these unbound identities and distinctions.
- **Source-bound action/operation IDs:** J-02 `media.action.begin-artifact-upload`
  → `media.operation-slice.begin-upload`, `media.action.view-job-status` →
  `media.operation.action.view-job-status`, and `media.action.inspect-source` →
  `media.operation-slice.inspect-artifact-version`; J-03
  `media.action.request-transcription` → `media.operation.transcription-submission`,
  `media.action.review-transcript` → `media.operation.transcript-version-read`,
  `media.action.correct-caption`/`media.action.align-caption-timing` →
  `media.operation.caption-draft-write`, `media.action.save-caption-version` →
  `media.operation.caption-version-write`, and
  `media.action.compare-caption-versions` → `media.operation.caption-version-read`.
- **Expected effect:** J-02 proposes an immutable artifact version becoming
  `AVAILABLE` only after verification. J-03 proposes a reviewable caption
  version linked to the exact audio source with timing, language, and provenance.
- **Failure/recovery:** J-02 preserves upload identity and acknowledged parts
  for safe resume; verification failure must not expose an unverified artifact.
  J-03 calls out uncertain language/timing, revoked consent, unknown provider
  outcome, and changed source version. Preserve output/source, keep the same job
  identity for outcome checks, and require an explicit rebase/restart for stale
  source. These are proposed journey semantics, not accepted behavior.
- **Binding gap:** J-03 still lacks per-step object/state/authority/transition
  refs and acceptance across the journey. The save/compare definitions are
  bounded owner-reviewed source definitions; other action/operation
  crosswalks remain proposal candidates, and runtime admission is not implied.
  Video transcription/audio extraction is explicitly outside the selected lane.

## Versioned caption time edits

**Family:** versioned caption time edits. **Status:** bounded save/compare source
definitions are owner-reviewed under PXD-060; runtime remains `NOT_ADMITTED`,
and no caption editor runtime is evidenced.

- **Trace:** [J-03](../.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml)
  uses `screen-contracts/correct-captions.yaml` and
  `screen-contracts/compare-caption-versions.yaml` after transcript review.
  The journey explicitly names `media.action.correct-caption` and
  `media.action.align-caption-timing` with candidate
  `media.operation.caption-draft-write` for draft edits. PDP-1 separately maps
  `media.action.save-caption-version` to `media.operation.caption-version-write`;
  J-03 binds comparison to `media.operation.caption-version-read`. Save and
  compare have bounded source definitions under PXD-060; runtime admission
  remains `NOT_ADMITTED`. Draft editing remains proposal-only.
- **P3-08 start/identity/authority/channel:** Start from J-03's exact audio
  artifact version and reviewed transcript revision. Current rights, consent,
  processing-location policy, and source version are preconditions. Candidate
  channel: none bound (the contract declares `media.surface.web`). The contract
  does not provide literal source/version IDs for this example.
- **P3-08 action/result/evidence:** `correct-caption` and `align-caption-timing`
  propose draft writes; `save-caption-version` proposes an immutable version;
  `compare-caption-versions` reads the version pair. Result/finality is a
  reviewable source-linked version proposal, not an accepted editor commit.
  Missing timing and changed source are explicit uncertainty; source, timing,
  language, and provenance are intended result fields, with no actual provenance
  record or result-version ID supplied.
- **Source-bound action/operation IDs:** `media.action.correct-caption` and
  `media.action.align-caption-timing` → `media.operation.caption-draft-write`;
  `media.action.save-caption-version` → `media.operation.caption-version-write`;
  `media.action.compare-caption-versions` → `media.operation.caption-version-read`.
- **Expected effect:** the journey-level proposal yields a reviewable caption
  version tied to the exact source, including timing and provenance; compare
  versions before treating a correction as final.
- **Failure/recovery:** if timing is missing, expose the gap and allow explicit
  correction instead of inventing exact timing. If the parent source changed,
  retain the draft as stale and require rebase/restart. If provider outcome is
  unknown, check the existing job rather than resubmitting.
- **Binding gap:** draft-edit action/operation links remain proposal candidates.
  The save/compare source definitions do not establish runtime behavior,
  independent review, or phase acceptance. State transitions are not applicable
  to immutable registration and read-only comparison; production admission
  remains open.

## Authorized voice synthesis to approved audio

**Family:** synthesis with authorized voice. **Status:** proposal; provider
availability and voice authorization are not inferred from a screen.

- **Trace:** [J-04](../.product-experience/pdp-3-product-experience/journey-contracts/authorized-text-to-speech-to-approved-audio.yaml)
  maps to `work-with-speech`, `use-authorized-voice`, `compare-results`, and
  `inspect-output` screen contracts. The current contract/oracle binds
  `media.action.inspect-voice-authorization` to
  `media.operation.action.inspect-voice-authorization`,
  `media.action.compare-candidate-on-metric` to
  `media.operation.action.compare-candidate-on-metric`, and
  `media.action.inspect-output-preview-and-version` to
  `media.operation.action.inspect-output-preview-and-version`.
- **P3-08 start/identity/authority/channel:** J-04 starts with admitted text,
  voice rights/consent, language, and output intent; actors are creator/reviewer.
  Candidate channels: `media.channel.web`, `media.channel.grpc-api`, and
  `media.channel.sdk`. No literal text revision, voice
  identity/version, or request ID is supplied by the definition.
- **P3-08 action/result/evidence:** The defined actions inspect voice
  authorization, compare candidates, and inspect output; synthesis request and
  approval-finality action/operation remain unbound. Proposed result: audio
  artifact with selected voice/version, format/rate, provenance, and approval
  status where required; no result version or measured output is supplied.
  Consent/provider/format uncertainty is named; provenance is a proposed field,
  not evidence that a voice or output was authorized.
- **Source-bound action/operation IDs:** `media.action.inspect-voice-authorization`
  → `media.operation.action.inspect-voice-authorization`,
  `media.action.compare-candidate-on-metric` →
  `media.operation.action.compare-candidate-on-metric`, and
  `media.action.inspect-output-preview-and-version` →
  `media.operation.action.inspect-output-preview-and-version`.
- **Expected effect:** the journey title/outcome proposes generated audio that
  is reviewed and approved before becoming the chosen output. The exact
  synthesis request and approval-finality operations are not assigned at step
  level; the inspection/comparison operations do not stand in for them.
- **Failure/recovery:** unsupported voice/language, pronunciation mismatch,
  consent denial, provider outage, and sample-format incompatibility are named
  exceptions. The proposal keeps text/plan and allows only an admitted
  permitted voice or non-speech route, with explicit choice for material
  changes; exact error state/action bindings remain pending.
- **Binding gap:** the synthesis request and approval-finality paths have no
  step-level operation binding; this does not remove the separately listed
  authorization, comparison, and output-inspection bindings. Exact state,
  authority, and recovery bindings for synthesis/approval remain open. No
  evidence says any listed voice provider is live or qualified.

## Mix/master with loudness evidence

**Family:** mix/master and loudness. **Status:** proposal; profile/provider
availability is not asserted.

- **Trace:** [J-17](../.product-experience/pdp-3-product-experience/journey-contracts/mix-and-master-music-and-effects.yaml)
  moves through `create-audio`, `compose-media`, `review-quality`, and
  `inspect-output` contracts. Its source oracle binds
  `media.action.inspect-quality-evidence` to
  `media.operation.action.inspect-quality-evidence` and
  `media.action.inspect-output-preview-and-version` to
  `media.operation.action.inspect-output-preview-and-version`; choosing an
  audio operation and editing mix controls remain local proposal actions.
- **P3-08 start/identity/authority/channel:** J-17 begins with explicit source
  and license scope, target profile, channel layout, and mastering intent;
  candidate channel: `media.channel.web`. No literal stem/source or profile ID
  is selected.
- **P3-08 action/result/evidence:** Choosing the audio operation and changing
  mix controls are local proposals; exact inspection operations are named in the
  trace. The proposed result preserves stems/decisions and records profile plus
  applicable loudness/peak measurements; no output-version ID or measurement
  source is supplied. Rights, clipping, leakage, layout, and profile
  availability are uncertainties; provenance/measurement evidence remains
  unbound and no mastering finality is claimed.
- **Source-bound action/operation IDs:** `media.action.inspect-quality-evidence`
  → `media.operation.action.inspect-quality-evidence` and
  `media.action.inspect-output-preview-and-version` →
  `media.operation.action.inspect-output-preview-and-version`. Choosing the
  admitted audio operation and editing mix controls have no canonical operation
  binding in J-17.
- **Expected effect:** the proposal preserves stems and mix decisions and
  describes recording a profile plus applicable loudness/peak measurements.
- **Failure/recovery:** preserve original stems/source, disclose unavailable or
  inapplicable measurements, and do not silently deliver a degraded master.
  Rights issues, clipping, separation leakage, channel layout, and unavailable
  mastering profile are named exceptions; their exact state/action treatment is
  pending.
- **Binding gap:** no accepted mastering operation, profile resolver, measured
  output fixture, or per-step error/recovery binding.

## Video repair, color, and quality comparison

**Family:** video repair/color/quality comparison. **Status:** proposal; no
repair or color provider is claimed available.

- **Trace:** [J-08](../.product-experience/pdp-3-product-experience/journey-contracts/repair-video-with-measured-quality.yaml)
  links `create-video`, `improve-media`, `compare-results`, and `review-quality`.
  [J-18](../.product-experience/pdp-3-product-experience/journey-contracts/compose-and-render-reviewed-media.yaml)
  includes `adjust-color` and `edit-captions` before render preparation.
  [J-19](../.product-experience/pdp-3-product-experience/journey-contracts/inspect-quality-and-optimize-within-bounds.yaml)
  starts from quality review, then proposes a bounded creation plan, comparison,
  and render preparation.
  Current step bindings are source-linked: J-08 uses
  `media.operation.action.submit-validated-request` for the selected repair and
  `media.operation.action.compare-candidate-on-metric` for comparison; J-18
  binds caption drafts to `media.operation.caption-draft-write` and render to
  `media.operation.action.submit-render`; J-19 binds its inspection, parameter
  review, comparison, and render actions to their corresponding source-defined
  operations. J-08's preservation/enhancement input
  matches the canonical closed typed input under PXD-157. None of these refs
  admits provider execution.
- **P3-08 start/identity/authority/channel:** J-08 starts by selecting one exact
  immutable video artifact version in the trusted tenant/workspace/project and
  current catalog; repair input envelope and budget must be admitted. J-18
  requires authorized exact assets/fonts/claims, timeline, color profile, and
  destination. Candidate channel for these journeys: `media.channel.web`. The
  example has no literal tenant/artifact/version IDs.
- **P3-08 action/result/evidence:** J-08 proposes validated repair submission
  and metric comparison; J-18 proposes caption draft and render; J-19 proposes
  inspection, parameter review, comparison, and render. Results are candidate
  comparisons/render preparation, not a committed output version. Metric
  applicability/abstention and temporal artifacts are uncertainty; no measured
  provenance or result-version evidence is supplied.
- **Source-bound action/operation IDs:** J-08
  `media.action.submit-validated-request` →
  `media.operation.action.submit-validated-request`, and
  `media.action.compare-candidate-on-metric` →
  `media.operation.action.compare-candidate-on-metric`, plus
  `media.action.inspect-quality-evidence` →
  `media.operation.action.inspect-quality-evidence`; J-18
  `media.action.correct-caption` → `media.operation.caption-draft-write` and
  `media.action.submit-render` → `media.operation.action.submit-render`; J-19
  binds `media.action.inspect-quality-evidence`,
  `media.action.compare-candidate-on-metric`, and `media.action.submit-render`
  to `media.operation.action.inspect-quality-evidence`,
  `media.operation.action.compare-candidate-on-metric`, and
  `media.operation.action.submit-render`; J-19
  `media.action.review-processing-parameters` →
  `media.operation.action.review-processing-parameters`.
- **Expected effect:** J-08 proposes a candidate that can be compared using
  applicable measures with limitations visible. J-18 proposes a composed
  version carrying its edits into render preparation.
- **Failure/recovery:** J-08 names insufficient recoverable detail, failed
  metric, temporal artifacts, and exhausted budget. Stop bounded work, keep
  source and safe completed candidates, and report metric abstention/failure.
- **Binding gap:** no accepted metric fixture establishes measured runtime
  output or provider qualification; color remains a proposed adjustment.

## Reviewed render and acknowledged delivery

**Family:** approved render/delivery. **Status:** proposal; external publication
and destination behavior are not live claims.

- **Trace:** [J-18](../.product-experience/pdp-3-product-experience/journey-contracts/compose-and-render-reviewed-media.yaml)
  covers compose, edit, color, captions, prepare-render, and inspect-output.
  [J-22](../.product-experience/pdp-3-product-experience/journey-contracts/deliver-export-with-destination-acknowledgement.yaml)
  covers inspect-output, deliver-output, and job-status across proposed Web,
  HTTP API, CLI, and integration surfaces. J-18 binds
  `media.action.submit-render` to `media.operation.action.submit-render`; J-22
  binds `media.action.deliver-exact-version` to
  `media.operation.action.deliver-exact-version` and job status to
  `media.operation.action.view-job-status`. These are definition references,
  not an admitted destination effect.
- **P3-08 start/identity/authority/channel:** Start from one exact output version
  and destination with current rights, approval, and external-effect authority.
  J-22 candidate channels: `media.channel.web`, `media.channel.http-api`,
  `media.channel.cli`, and `media.channel.product-integration`. No literal
  output, destination, request, or effect/idempotency ID is supplied.
- **P3-08 action/result/evidence:** J-18 proposes render submission; J-22
  proposes delivery of that exact version and job observation. Finality requires
  later authoritative destination acknowledgment where applicable; no receipt
  or new output-version ID is present. Timeout-after-effect remains UNKNOWN
  pending reconciliation by effect/idempotency identity. Provenance inspection
  is a candidate action, but no receipt/provenance record is evidenced.
- **Source-bound action/operation IDs:** J-18 `media.action.submit-render` →
  `media.operation.action.submit-render`, and
  `media.action.inspect-output-preview-and-version` →
  `media.operation.action.inspect-output-preview-and-version`; J-22
  `media.action.inspect-output-preview-and-version` →
  `media.operation.action.inspect-output-preview-and-version`,
  `media.action.deliver-exact-version` →
  `media.operation.action.deliver-exact-version`, and
  `media.action.view-job-status` → `media.operation.action.view-job-status`.
- **Expected effect:** the proposal separates package validity, transport, and
  external publication; successful delivery requires a destination
  acknowledgement/receipt where applicable.
- **Failure/recovery:** partial package, destination rejection, timeout after a
  possible effect, or approval-scope mismatch are explicit exceptions. Reconcile
  by effect/idempotency identity before retry; unknown publication is neither
  success nor failure.
- **Binding gap:** no accepted destination adapter/acknowledgement fixture or
  production external-effect authority.

## Scene, animation, simulation, and interchange loss

**Family:** scene/animation/simulation/interchange. **Status:** proposal; these
contracts do not qualify a renderer, simulation engine, or interchange codec.

- **Trace:** [J-12 vector/procedural animation](../.product-experience/pdp-3-product-experience/journey-contracts/animate-vector-or-procedural-scenes.yaml)
  uses `animate-media`, `compare-results`, `inspect-output`;
  [J-13 3D animation](../.product-experience/pdp-3-product-experience/journey-contracts/animate-3d-scenes-and-characters.yaml)
  uses `compose-scene`, `animate-media`, `prepare-render`, `inspect-output`;
  [J-14 simulation](../.product-experience/pdp-3-product-experience/journey-contracts/explore-domain-simulation-and-review-measurements.yaml)
  uses `compose-scene`, `explore-simulation`, `review-quality`, `prepare-render`;
  [J-15](../.product-experience/pdp-3-product-experience/journey-contracts/refine-simulation-passes-with-semantic-validation.yaml)
  adds refinement/semantic validation; [J-28 spatial export](../.product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml)
  traces scene/animation through render and delivery.
- **P3-08 start/identity/authority/channel:** These grouped journeys have
  separate starts: J-12 declares animation controls/timing/export subset; J-13
  identifies scene/rig assets, coordinate convention, rights, and interchange
  subset; J-14 identifies domain owner/model, equations, units, validity range,
  solver envelope, and fidelity; J-15 identifies domain truth/protected
  semantics; J-28 declares destination subset, coordinate/time conventions,
  synthetic labeling, and licensing. Candidate channel is `media.channel.web`
  for J-12/13; J-14/15/28 declare `media.channel.web` and
  `media.channel.product-integration`. Exact asset/model/scene/version IDs are
  not supplied in this example.
- **P3-08 action/result/evidence:** Journey actions cover keyframe/scene edits,
  simulation inspection/refinement, semantic validation, render, and export
  inspection; local edits have no canonical operation in the cited contracts.
  Results are proposed candidate/render/loss reports, not computed outputs or
  committed versions. Unsupported features, conversion loss, semantic
  validation, and coordinate/time/format mismatch are uncertainty sources;
  per-family provenance and exact result version are unbound.
- **Source-bound action/operation IDs:** J-12
  `media.action.compare-candidate-on-metric` →
  `media.operation.action.compare-candidate-on-metric` and
  `media.action.inspect-output-preview-and-version` →
  `media.operation.action.inspect-output-preview-and-version`; J-13
  `media.action.submit-render` → `media.operation.action.submit-render` and
  `media.action.inspect-output-preview-and-version` →
  `media.operation.action.inspect-output-preview-and-version`; J-14
  `media.action.inspect-simulation-result` →
  `media.operation.action.inspect-simulation-result`,
  `media.action.inspect-quality-evidence` →
  `media.operation.action.inspect-quality-evidence`, and
  `media.action.submit-render` → `media.operation.action.submit-render`; J-15
  `media.action.review-processing-parameters` →
  `media.operation.action.review-processing-parameters`,
  `media.action.inspect-simulation-result` →
  `media.operation.action.inspect-simulation-result`,
  `media.action.inspect-quality-evidence` →
  `media.operation.action.inspect-quality-evidence`, and
  `media.action.compare-candidate-on-metric` →
  `media.operation.action.compare-candidate-on-metric`; J-28
  `media.action.submit-render` → `media.operation.action.submit-render`.
- **Expected effect:** compare a deterministic/procedural or 3D candidate and
  preserve relevant measurements/declared format loss in output review. These
  are proposed journey outcomes, not computed results in this example.
- **Failure/recovery:** source contracts describe comparison and semantic
  validation, but do not provide accepted per-step failure actions or a runtime
  recovery contract for these family examples.
- **Binding gap:** local scene/keyframe edits have no canonical operation in
  the current contracts; no interchange loss fixture or engine qualification
  is present. The bound inspect/compare/simulation/render definitions remain
  proposals.

## Generation from references with provenance review

**Family:** generative media with reference/provenance. **Status:** proposal;
reference rights and provider qualification remain external prerequisites.

- **Trace:** [J-10](../.product-experience/pdp-3-product-experience/journey-contracts/generate-from-references-and-review-continuity.yaml)
  orders `review-creation-plan`, `create-video`, `animate-media`,
  `review-quality`, and `compare-results`; related inspection is defined by
  `screen-contracts/inspect-provenance.yaml`.
- **Expected effect:** a candidate is compared for continuity and reviewed with
  its source/reference provenance before use; generation is not described as
  accepted or automatically approved.
- **Failure/recovery:** reference rights/policy must be checked before use;
  the journey names identity/geometry drift, unsupported control, AI
  unavailability, and inferred identity treated as proof as exceptions. J-10
  binds parameter review, validated submission, quality evidence, and
  comparison to their exact source-defined operations; keyframe
  editing remains local. Exact per-condition recovery and retry behavior are
  not allocated by J-10.
- **Binding gap:** no source-backed reference-asset fixture proves continuity
  or provenance correctness. The separate exact source-lineage read is defined
  by [J-21](../.product-experience/pdp-3-product-experience/journey-contracts/review-exact-version-and-recheck-changes.yaml),
  `media.action.inspect-provenance` →
  `media.provenance.source-lineage.inspect` →
  `media.operation-slice.inspect-provenance`. PXD-152 accepts the
  caller-scoped ProcessingJob/JobAttempt lookup branch, excludes MediaRun,
  preserves non-disclosing UNKNOWN, and leaves runtime `NOT_ADMITTED`.
- **P3-08 start/identity/authority/channel:** J-10 starts from rights-checked
  references/controls with protected identity and geometry constraints; candidate
  channel: `media.channel.web`. The contract has artifact-version targets but no literal
  reference, source-version, or request IDs in this example.
- **P3-08 action/result/evidence:** J-10 binds parameter review, validated
  submission, quality evidence, and comparison; keyframe edits remain local.
  Result is a proposed continuity-reviewed candidate, with no committed version
  ID/finality. Identity/geometry drift, unsupported controls, unavailable AI,
  and inferred identity are explicit uncertainties. J-21 supplies the separate
  provenance-read chain and scoped UNKNOWN disposition; it does not prove
  reference rights or candidate provenance correctness.
- **Source-bound action/operation IDs:** `media.action.review-processing-parameters`
  → `media.operation.action.review-processing-parameters`,
  `media.action.submit-validated-request` →
  `media.operation.action.submit-validated-request`, and
  `media.action.inspect-quality-evidence` →
  `media.operation.action.inspect-quality-evidence`, and
  `media.action.compare-candidate-on-metric` →
  `media.operation.action.compare-candidate-on-metric`.

## Offline work and conflict reconciliation

**Family:** offline conflict. **Status:** proposal; local deterministic fixture
coverage is not equivalent to a synced production client.

- **Trace:** [J-23](../.product-experience/pdp-3-product-experience/journey-contracts/work-locally-and-reconcile-after-reconnect.yaml)
  orders `media.view.work-in-project` → `media.view.inspect-media` →
  `media.view.job-status` → `media.view.review-activity`, using the
  corresponding `work-in-project`, `inspect-media`, `job-status`, and
  `review-activity` screen contracts.
  [PDP-1 offline/sync contract](../.product-experience/pdp-1-domain-data/offline-sync.yaml)
  is the domain source for reconciliation semantics.
- **Expected effect:** retain local work while disconnected, then reconcile
  against server state after reconnect; conflicting or stale work must be
  surfaced for resolution instead of overwritten silently.
- **Failure/recovery:** the journey proposes context preservation and
  reconciliation before submission. If entitlement expires offline, a local
  capability is unavailable, or reconnect would require unauthorized egress,
  block that path; exact conflict state/actions remain unbound. Do not replay a
  consequential operation merely because a client reconnects. J-23 binds
  artifact inspection to `media.operation-slice.inspect-artifact` and job
  observation to `media.operation.action.view-job-status`.
- **P3-08 start/identity/authority/channel:** J-23 requires admitted local
  capability, offline mode, cached-asset permission, and storage policy; it
  starts in project context and preserves offline edits plus remote-work
  identity. Candidate channels: `media.channel.web` and `media.channel.cli`.
  Exact project/source/version and
  remote-work IDs are not instantiated here.
- **P3-08 action/result/evidence:** The trace orders project, media inspection,
  job status, and activity review; only artifact inspection and job observation
  are operation-bound. Result is proposed local-work preservation followed by
  explicit stale/conflict reconciliation, not a new committed version. Stale
  catalog, expired entitlement, unavailable local capability, and unauthorized
  egress remain uncertainty/hold conditions. No conflict receipt or provenance
  record is supplied.
- **Source-bound action/operation IDs:** `media.action.inspect-artifact` →
  `media.operation-slice.inspect-artifact` and `media.action.view-job-status` →
  `media.operation.action.view-job-status`. Local work/reconciliation has no
  bound commit action or operation in this trace.
- **Binding gap:** no source scenario reference for J-23 and no complete
  conflict/recovery fixture or production offline client evidence.

## Live session loss and reconnect

**Family:** live session loss/reconnect. **Status:** PDP-0-grounded contract;
transport and owner semantics remain pending review.

- **Trace:** [J-29](../.product-experience/pdp-3-product-experience/journey-contracts/live-session-loss-consent-change-and-bounded-recovery.yaml)
  orders `media.view.work-in-project`, `media.view.job-status`, and
  `media.view.review-activity` and models session loss, consent change, and
  bounded recovery.
- **Expected effect:** session recovery must respect current consent and bound
  recovery; it cannot be treated as proof that a dropped request did or did not
  take effect.
- **Failure/recovery:** loss/reconnect and consent changes are in the journey
  scope. The proposed recovery fences new frame submission, uses prior consent
  only for permitted termination, and reconciles dispatched-frame effects
  before opening a new session. Retry/reconnect/drain/close semantics still
  require transport and service-owner review.
- **Binding gap:** transport/runtime semantics and scenario fixtures are
  pending. The terminal reconnect step binds to
  `media.operation.capability.media-stream-session-reconnect`; earlier
  session/consent observations have no direct operation IDs.
- **P3-08 start/identity/authority/channel:** J-29 starts with stable session
  and frame identity, bounded buffers, a current lease, and authoritative
  consent scope; `media.channel.web` and `media.channel.grpc-api` are candidate
  channels. The contract names session,
  frame, lease, consent, job, and attempt objects but gives no concrete IDs.
- **P3-08 action/result/evidence:** Detect-loss/consent observation has no bound
  query; terminal reconnect binds to
  `media.operation.capability.media-stream-session-reconnect`. Seven guards
  cover same scope, degraded session, current consent/fence, resolved prior
  effects, budget, and contiguous sequence. Result is closed/drained or
  explicitly unknown effects, not a new media version. Missing/stale owner
  observation remains UNKNOWN; no transport receipt/provenance evidence exists.
- **Source-bound action/operation IDs:** the reconnect capability operation is
  `media.operation.capability.media-stream-session-reconnect`; loss/consent
  observation has no bound action or operation ID. After its eligibility gate,
  J-29 binds `media.action.request-live-session-reconnect` to that exact
  operation; this is an owner-defined request, with runtime admission
  `NOT_ADMITTED`, not a claim that the session was restored or a frame sent.

## Headless CLI batch

**Family:** headless CLI batch. **Status:** proposal; CLI contract exists but
does not establish that a production host runs the batch.

- **Trace:** [J-24](../.product-experience/pdp-3-product-experience/journey-contracts/run-cli-batch-and-review-verified-outputs.yaml)
  maps to `create-media`, `review-creation-plan`, `job-status`, and
  `review-outputs`; see the [CLI command registry](../.product-experience/pdp-3-product-experience/cli/command-registry.yaml).
- **Expected effect:** a bounded batch plan is reviewed, job progress is
  observed, and outputs are reviewed for verification before use.
- **Failure/recovery:** the contract names SIGINT, duplicate keys, same key
  with changed content, per-item partial failure, malformed JSON, and uncertain
  effect. Proposed recovery separates stopping observation from cancellation,
  reconciles accepted work, and continues only unambiguous eligible items.
  J-24 binds parameter review, job status, and artifact inspection to their
  exact action/operation definitions.
- **P3-08 start/identity/authority/channel:** J-24 requires accepted public
  command/request schema, explicit approval/policy input, client keys, and
  per-item budgets; candidate channels: `media.channel.cli` and
  `media.channel.http-api`. No literal request,
  idempotency key, item, or output-version ID is instantiated.
- **P3-08 action/result/evidence:** The source binds parameter review, job
  status, and artifact inspection; the example does not spell out each exact ID.
  Proposed result is per-item state plus inspected verified outputs, with no
  output-version value or accepted finality. SIGINT, duplicate/changed keys,
  partial failure, malformed JSON, and uncertain effect are named; reconcile
  before repeat effects. No captured provenance or host result is asserted.
- **Source-bound action/operation IDs:** `media.action.review-processing-parameters`
  → `media.operation.action.review-processing-parameters`,
  `media.action.view-job-status` → `media.operation.action.view-job-status`, and
  `media.action.inspect-artifact` → `media.operation-slice.inspect-artifact`.
- **Binding gap:** no J-24 scenario fixture or admitted CLI host/runtime
  evidence for this journey.

## API, SDK, and Agent bounded result

**Family:** API/SDK/Agent bounded result. **Status:** proposal and definition
contracts only; no unadmitted integration is described as runnable.

- **Trace:** [J-25](../.product-experience/pdp-3-product-experience/journey-contracts/return-bounded-results-to-integrating-products.yaml)
  follows creation-plan review, job-status, and output inspection. Supporting
  registries are [API mapping](../.product-experience/pdp-3-product-experience/api-experience-mapping.yaml),
  [SDK operations](../.product-experience/pdp-3-product-experience/sdk/operation-registry.yaml),
  and [Agent tools](../.product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml).
- **Expected effect:** return a bounded, typed result to an integrating product
  with output identity/provenance and job state available for inspection.
- **Failure/recovery:** expired delegation, recursive budget reset,
  self-authorizing action, and a result returned without Media finality are
  named exceptions. Proposed recovery stops at declared budget, preserves
  request identity, returns a safe reason code, and reconciles before a repeated
  effect. J-25 binds parameter review, job status, and output inspection to
  their exact action/operation definitions, but this does not establish a
  runnable request/response transcript or per-channel recovery binding.
- **Binding gap:** no J-25 scenario fixture or admitted integration exists.
  Keep the API/SDK/Agent request-response payloads out of scope until exact
  public schemas and owner bindings are selected; do not infer them from
  similarly named transport routes.
- **P3-08 start/identity/authority/channel:** J-25 requires an admitted public
  Media action, bounded authority/delegation, recursion/cost limits, and return
  contract; candidate channels: `media.channel.product-integration` and
  `media.channel.http-api`. Exact payload
  schemas and request/result IDs are explicitly not selected/bound.
- **P3-08 action/result/evidence:** J-25 binds parameter review, job status,
  and output inspection. Its source-defined scoped result fields are
  `requestId`, `exactTargetRef`, `ownerReceipt`, and `observedAt`; missing/stale
  evidence is UNKNOWN. The proposed bounded result carries output identity and
  provenance plus job state, but no literal result-version ID, channel parity,
  or runnable transcript is supplied. Delegation expiry, recursive budget
  reset, self-authorization, and absent Media finality remain explicit gaps.
- **Source-bound action/operation IDs:** `media.action.review-processing-parameters`
  → `media.operation.action.review-processing-parameters`,
  `media.action.view-job-status` → `media.operation.action.view-job-status`, and
  `media.action.inspect-output-preview-and-version` →
  `media.operation.action.inspect-output-preview-and-version`.

### Observed HTTP transport example: list processing jobs

The current OpenAPI file does support a limited **transport-shape** example for
`GET /api/v1/jobs`. This is an illustration of the published HTTP contract,
not an execution transcript, PDP-1 operation binding, or implementation of
`media.search.authorized-jobs`. The endpoint declares bearer or API-key
authentication, a required tenant header, and an optional `limit` from 1 to
1000 (default 100). Its `200` body is an object with a `jobs` array of
`ProcessingJob` records.

```http
GET /api/v1/jobs?limit=25 HTTP/1.1
Host: media.example.invalid
Authorization: Bearer <authorized-token>
X-Tenant-Id: <current-tenant>
Accept: application/json
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "jobs": [
    {
      "jobId": "<job-id>",
      "requestId": "<request-id>",
      "tenantId": "<current-tenant>",
      "principalId": "<principal-id>",
      "artifactId": "<artifact-id>",
      "jobType": "SPEECH_TO_TEXT",
      "providerId": null,
      "status": "OUTCOME_UNKNOWN",
      "createdAt": "<RFC-3339 timestamp>",
      "startedAt": null,
      "completedAt": null,
      "result": {},
      "failureCode": null,
      "version": 1
    }
  ]
}
```

The placeholders are not a captured service response. `OUTCOME_UNKNOWN` is
retained as the transport spelling and must not be rewritten as running,
failed, or final. The route declares no search filters, continuation token, or
sort order. Those query semantics and empty/denied/stale-index distinctions are
defined separately in the [Media search contract](../.product-experience/pdp-3-product-experience/search-inspection-contracts.yaml),
but are not bound to this HTTP route. The crosswalk explicitly leaves its PDP-1 logical operation null and owner review pending;
transport execution remains `NOT_ADMITTED`. This example does not make the
job-search contract runnable.

## P3-08 coverage and remaining gaps

| P3-08 family | Trace | Current source status / unresolved dependency |
| --- | --- | --- |
| Upload → verify → transcribe/correct | J-02, J-03 | Proposal; real transfer and complete channel coverage pending; J-03 audio-only lane. |
| Versioned caption time edits | J-03 | Proposal; correction operation/state/finality not step-bound. |
| Authorized voice synthesis | J-04 | Definition trace binds authorization inspection, candidate comparison, and output inspection; synthesis request and approval finality remain unbound. |
| Mix/master and loudness | J-17 | Definition trace binds quality evidence and output inspection; operation selection, measurement source, and profile remain unresolved. |
| Video repair/color/quality | J-08, J-18, J-19 | Definition trace binds validated submission, selected enhancement, quality comparison, draft edit, and render proposals; measured fixture/runtime remains unadmitted. |
| Approved render/delivery | J-18, J-22 | Definition trace binds render and exact-version delivery proposals; destination receipt/authority runtime remains unadmitted. |
| Scene/animation/simulation/interchange loss | J-12–J-15, J-28 | Proposal; engine/codec qualification and loss fixture pending. |
| Generation from references/provenance | J-10 | Definition trace binds parameter review, validated submission, quality evidence, and comparison; source rights and continuity fixture remain unresolved. |
| Offline conflict | J-23 | Definition trace binds artifact inspection and job observation; conflict/recovery fixture remains unresolved. |
| Live session loss/reconnect | J-29 | Definition trace binds reconnect to the source capability and seven typed guards; transport fixture/runtime remains unadmitted. |
| Headless CLI batch | J-24 | Definition trace binds parameter review, job status, and artifact inspection; executable host/runtime remains unadmitted. |
| API/SDK/Agent bounded result | J-25 | Definition trace binds parameter review, job status, and output inspection; no J-25 fixture or admitted integration. |

### Source evidence by family

The 12 rows above are the P3-08 feature-family denominator from the execution
plan. The table below makes the definition evidence and its limits explicit.
`Seeded` means a synthetic fixture is linked by the journey contract; it does
not mean the family has an accepted end-to-end oracle. `Conditional` means the
source has a bounded definition that still depends on missing evidence or
authority. `Unimplemented` means no applicable source fixture or complete
definition trace is present for this family. These labels describe source
coverage only.

| Family | Source fixture disposition | Exact definition trace and user-visible outcome | Missing source evidence / disposition |
| --- | --- | --- | --- |
| Source upload, verification, and caption correction | **Seeded, conditional.** J-02 and J-03 are among the four seeded journeys. | [J-02 steps](../.product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml) bind `media.action.begin-artifact-upload` → `media.operation-slice.begin-upload`, job status → `media.operation.action.view-job-status`, and exact-version inspection → `media.operation-slice.inspect-artifact-version`. The inspection returns a time-scoped recorded disposition and does not establish current availability or authorization. Exact states are `media-upload-and-artifact/{RECEIVING,VERIFYING,REJECTED,EXPIRED,AVAILABLE,QUARANTINED}` from [PDP-1 state definitions](../.product-experience/pdp-1-domain-data/states.yaml). Its linked fixtures include `media.scenario.upload-interrupted`, `media.scenario.upload-outcome-unknown`, `media.scenario.artifact-verification-running`, `media.scenario.upload-checksum-mismatch`, and `media.scenario.upload-verified-available`. [J-03](../.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml) binds transcription submission, transcript read, and caption version writes; [PXD-060 operations](../.product-experience/pdp-1-domain-data/operations.yaml) defines the bounded save/compare sources. | Conditional on real transfer, current authority, and accepted outcome oracles. J-03 remains the selected audio lane; no video-transcription claim. |
| Versioned caption time edits | **Seeded, conditional.** J-03 links `media.scenario.alignment-required`, `media.scenario.caption-conflict`, and `media.scenario.caption-version-comparison`. | [J-03](../.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml) binds correction/alignment to `media.operation.caption-draft-write`, save to `media.operation.caption-version-write`, and compare to `media.operation.caption-version-read`. [Caption source definitions](../.product-experience/pdp-1-domain-data/operations.yaml) specify draft vs immutable version behavior; expected visible result is an exact source-tied version pair or explicit incompatibility. | Draft remains proposal-only; save/compare runtime is `NOT_ADMITTED`. No accepted editor oracle. |
| Authorized voice synthesis to approved audio | **Unimplemented fixture; definition-only proposal.** J-04 has no scenario refs. | [J-04](../.product-experience/pdp-3-product-experience/journey-contracts/authorized-text-to-speech-to-approved-audio.yaml) has inspect-authorization, compare-metric, and inspect-output actions/operation definitions. The proposed visible result is a reviewed candidate with voice authorization and metric context. | No exact scenario fixture, authorized voice evidence, or accepted approval/finality trace. Remains out of runnable examples until those sources exist. |
| Mix/master with loudness evidence | **Unimplemented fixture; definition-only proposal.** J-17 has no scenario refs. | [J-17](../.product-experience/pdp-3-product-experience/journey-contracts/mix-and-master-music-and-effects.yaml) defines choosing an admitted operation, mix controls, quality evidence, and output inspection. The proposed result preserves stems and exposes applicable loudness/peak measurements or their absence. | No accepted mastering operation, profile resolver, or measured-output fixture. |
| Video repair, color, and quality comparison | **Unimplemented fixture; definition-only proposal.** J-08/J-18/J-19 have no scenario refs. | [J-08](../.product-experience/pdp-3-product-experience/journey-contracts/repair-video-with-measured-quality.yaml) binds validated submission and metric comparison; [J-18](../.product-experience/pdp-3-product-experience/journey-contracts/compose-and-render-reviewed-media.yaml) and [J-19](../.product-experience/pdp-3-product-experience/journey-contracts/inspect-quality-and-optimize-within-bounds.yaml) bind render/job states and quality evidence. The visible result is a candidate comparison with metric applicability and limitations. | No accepted repair/color metric oracle or applicable scenario fixture; provider execution remains unadmitted. |
| Reviewed render and acknowledged delivery | **Unimplemented fixture; definition-only proposal.** J-18/J-22 have no scenario refs. | [J-18](../.product-experience/pdp-3-product-experience/journey-contracts/compose-and-render-reviewed-media.yaml) binds `media.action.submit-render` to `media.operation.action.submit-render` and [PDP-1 job/attempt states](../.product-experience/pdp-1-domain-data/states.yaml). [J-22](../.product-experience/pdp-3-product-experience/journey-contracts/deliver-export-with-destination-acknowledgement.yaml) defines exact-version delivery and visible job status. | No destination-acknowledgement fixture or accepted external-effect authority/result source. |
| Scene, animation, simulation, and interchange loss | **Unimplemented fixture; definition-only proposals.** J-12–J-15/J-28 have no scenario refs. | [J-12](../.product-experience/pdp-3-product-experience/journey-contracts/animate-vector-or-procedural-scenes.yaml), [J-13](../.product-experience/pdp-3-product-experience/journey-contracts/animate-3d-scenes-and-characters.yaml), [J-14](../.product-experience/pdp-3-product-experience/journey-contracts/explore-domain-simulation-and-review-measurements.yaml), [J-15](../.product-experience/pdp-3-product-experience/journey-contracts/refine-simulation-passes-with-semantic-validation.yaml), and [J-28](../.product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml) name edit, simulation, comparison, render, and output-inspection actions. | No engine/codec qualification, measured fixture, format-loss oracle, or per-family guard/state recovery trace. |
| Generation from references with provenance review | **Unimplemented fixture; definition-only proposal.** J-10 has no scenario refs. | [J-10](../.product-experience/pdp-3-product-experience/journey-contracts/generate-from-references-and-review-continuity.yaml) binds validated submission to job/attempt state and proposes continuity comparison plus quality/provenance inspection. | No exact reference fixture, rights evidence, or continuity/provenance oracle. |
| Offline work and conflict reconciliation | **Unimplemented fixture; definition-only proposal.** J-23 has no scenario refs. | [J-23](../.product-experience/pdp-3-product-experience/journey-contracts/work-locally-and-reconcile-after-reconnect.yaml) binds artifact inspection and job status; [PDP-1 offline/sync](../.product-experience/pdp-1-domain-data/offline-sync.yaml) defines reconciliation semantics. Visible outcome is preserved local work plus explicit stale/conflict resolution. | No applicable scenario seed, step-level conflict state/action binding, or production offline client evidence. |
| Live session loss and reconnect | **Unimplemented fixture; conditional source definition.** J-29 has no scenario refs. | [J-29](../.product-experience/pdp-3-product-experience/journey-contracts/live-session-loss-consent-change-and-bounded-recovery.yaml) binds reconnect to `media.operation.capability.media-stream-session-reconnect`; its guards are `media.guard.stream.reconnect.same-session-scope`, `media.guard.stream.reconnect.degraded-session`, `media.guard.stream.reconnect.current-consent`, `media.guard.stream.reconnect.current-fence`, `media.guard.stream.reconnect.prior-effects-resolved`, `media.guard.stream.reconnect.budget-available`, and `media.guard.stream.reconnect.next-sequence-contiguous`. The exact session, attempt, and consent state source is [PDP-1 state definitions](../.product-experience/pdp-1-domain-data/states.yaml). The visible state is bounded session recovery or a degraded/blocked reason. | Conditional on owner and transport review; no session-loss fixture or runtime claim. |
| Headless CLI batch | **Unimplemented journey fixture; local simulator is definition-only.** J-24 has no scenario refs. | [J-24](../.product-experience/pdp-3-product-experience/journey-contracts/run-cli-batch-and-review-verified-outputs.yaml) defines plan review, job status, and verified-output inspection; the [CLI registry](../.product-experience/pdp-3-product-experience/cli/command-registry.yaml) defines command shapes. Visible result reports per-item state and verified outputs without converting interruption into cancellation. | No J-24 fixture or admitted host/runtime. Local synthetic command simulation does not establish batch execution. |
| API, SDK, and Agent bounded result | **Unimplemented fixture; channel definitions only.** J-25 has no scenario refs. | [J-25](../.product-experience/pdp-3-product-experience/journey-contracts/return-bounded-results-to-integrating-products.yaml) traces parameter review, job status, and exact output inspection; [API mapping](../.product-experience/pdp-3-product-experience/api-experience-mapping.yaml), [SDK operations](../.product-experience/pdp-3-product-experience/sdk/operation-registry.yaml), and [Agent tools](../.product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml) define their respective machine surfaces. | No exact public operation/owner binding or J-25 fixture oracle; no channel parity or runnable integration claim. |

The fixture count remains **31 source-backed seeds across four journeys**
(J-01/J-02/J-03/J-20); only J-02 and J-03 intersect these 12 selected
families. The other 26 journey contracts remain unseeded, and a scenario
attached to a journey does not imply every step or family has a fixture. The
family-specific unresolved sources above are therefore explicit definition
gaps, not silently excluded capabilities. The source-lineage crosswalk used by
review examples is exact: `media.action.inspect-provenance` →
`media.provenance.source-lineage.inspect` →
`media.operation-slice.inspect-provenance`; [PXD-152](../.product-experience/decision-log.md)
accepts only caller-scoped ProcessingJob/JobAttempt lookup, excludes MediaRun,
and retains non-disclosing UNKNOWN with runtime `NOT_ADMITTED`.

P3-08 definition-grade coverage is documented for all 12 families: seeded
examples remain explicitly conditional, and families without a typed scenario
fixture have an explicit source-backed limitation or out-of-scope boundary.
none of these examples is an accepted end-to-end capability. No unqualified
provider, codec, model, or runtime is described as live.

## Local source checks

Regenerate the product-definition manifest after authored source changes with
`pnpm generate:product-definition-manifest`, then run `pnpm check:product-experience-local`.
The focused P3-08 test checks that family entries trace to existing J-01…J-30
journey contracts and that every listed family declares status, expected effect,
failure/recovery, and any binding gap. It is structural documentation checking,
not semantic acceptance.
