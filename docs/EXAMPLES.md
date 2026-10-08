# Media product examples

This page gives source-traceable journey examples, not runtime recipes. “Complete”
here means the source journey can be followed from its stated input/preconditions
through its intended result and stated exception/recovery intent. It does not mean
the flow is accepted, deployed, or available from a provider. The underlying
journey registry reports 30 contracts and 130 ordered steps, with only 18
step-level action links, 7 candidate operation links, and 3 journeys with
scenario references; semantic acceptance remains pending.

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

## Source upload, verification, and caption correction

**Family:** source upload → verify → transcribe/correct. **Status:** J-02 and
J-03 are proposals; J-02 has metadata-only synthetic fixtures, and J-03 is a
selected audio-source proposal. Real byte transfer, provider execution, and the
full video-transcription path are not established.

- **Trace:** [J-02 upload/import/verify](../.product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml)
  orders source selection/import, upload/job observation, and artifact
  inspection. Its terminal step is `media.action.inspect-artifact`, bound in
  J-02 to candidate `media.operation.artifact-ingest`; the earlier
  `media.action.attach-source-asset` action is not the terminal step.
  [J-03 transcription/correction](../.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml)
  continues through `select-source`, `monitor-transcription`, `review-transcript`,
  `correct-captions`, and `compare-caption-versions`. J-03 names
  `media.action.choose-source` and `media.action.request-transcription` as
  proposal actions. Caption correction is more specifically mapped in J-03 to
  `media.action.correct-caption`, `media.action.align-caption-timing`, and
  `media.action.save-caption-version`. The PDP-1 proposal maps the first two to
  `media.operation.caption-draft-write` and separately maps save to
  `media.operation.caption-version-write`; J-03 copies that candidate into the
  save step's `canonicalOperationRef` and marks owner acceptance pending. The
  comparison step still has no operation assignment.
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
  refs and acceptance. Its few action/operation crosswalks are proposal
  candidates, not accepted behavior. Video transcription/audio extraction is
  explicitly outside the selected lane.

## Versioned caption time edits

**Family:** versioned caption time edits. **Status:** proposal; no caption editor
runtime or accepted edit operation is evidenced.

- **Trace:** [J-03](../.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml)
  uses `screen-contracts/correct-captions.yaml` and
  `screen-contracts/compare-caption-versions.yaml` after transcript review.
  The journey explicitly names `media.action.correct-caption` and
  `media.action.align-caption-timing` with candidate
  `media.operation.caption-draft-write` for draft edits. PDP-1 separately maps
  `media.action.save-caption-version` to `media.operation.caption-version-write`,
  which J-03 records as a proposal candidate with owner acceptance pending. The
  comparison step still has no operation assignment.
- **Expected effect:** the journey-level proposal yields a reviewable caption
  version tied to the exact source, including timing and provenance; compare
  versions before treating a correction as final.
- **Failure/recovery:** if timing is missing, expose the gap and allow explicit
  correction instead of inventing exact timing. If the parent source changed,
  retain the draft as stale and require rebase/restart. If provider outcome is
  unknown, check the existing job rather than resubmitting.
- **Binding gap:** draft-edit action/operation links remain proposal candidates;
  J-03 has not propagated the save operation, and the comparison step has none.
  State transition, accepted versioning/finality, and owner review remain open.

## Authorized voice synthesis to approved audio

**Family:** synthesis with authorized voice. **Status:** proposal; provider
availability and voice authorization are not inferred from a screen.

- **Trace:** [J-04](../.product-experience/pdp-3-product-experience/journey-contracts/authorized-text-to-speech-to-approved-audio.yaml)
  maps to `work-with-speech`, `use-authorized-voice`, `compare-results`, and
  `inspect-output` screen contracts. Each journey step currently has a null
  `actionRef` and `canonicalOperationRef`.
- **Expected effect:** the journey title/outcome proposes generated audio that
  is reviewed and approved before becoming the chosen output. The exact
  synthesis operation and approval finality are not assigned at step level.
- **Failure/recovery:** unsupported voice/language, pronunciation mismatch,
  consent denial, provider outage, and sample-format incompatibility are named
  exceptions. The proposal keeps text/plan and allows only an admitted
  permitted voice or non-speech route, with explicit choice for material
  changes; exact error state/action bindings remain pending.
- **Binding gap:** no step-level operation, state, authority, or recovery case;
  no evidence that any listed voice provider is live or qualified.

## Mix/master with loudness evidence

**Family:** mix/master and loudness. **Status:** proposal; profile/provider
availability is not asserted.

- **Trace:** [J-17](../.product-experience/pdp-3-product-experience/journey-contracts/mix-and-master-music-and-effects.yaml)
  moves through `create-audio`, `compose-media`, `review-quality`, and
  `inspect-output` contracts. Step actions and canonical operations are null.
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
  Journey-level `actionRef` and canonical operations are null in these proposals.
- **Expected effect:** J-08 proposes a candidate that can be compared using
  applicable measures with limitations visible. J-18 proposes a composed
  version carrying its edits into render preparation.
- **Failure/recovery:** J-08 names insufficient recoverable detail, failed
  metric, temporal artifacts, and exhausted budget. Stop bounded work, keep
  source and safe completed candidates, and report metric abstention/failure.
- **Binding gap:** no step-level color/repair operation, metric oracle, or
  accepted quality fixture; the comparison screens are not proof of measured
  runtime output.

## Reviewed render and acknowledged delivery

**Family:** approved render/delivery. **Status:** proposal; external publication
and destination behavior are not live claims.

- **Trace:** [J-18](../.product-experience/pdp-3-product-experience/journey-contracts/compose-and-render-reviewed-media.yaml)
  covers compose, edit, color, captions, prepare-render, and inspect-output.
  [J-22](../.product-experience/pdp-3-product-experience/journey-contracts/deliver-export-with-destination-acknowledgement.yaml)
  covers inspect-output, deliver-output, and job-status across proposed Web,
  HTTP API, CLI, and integration surfaces. J-22 screen candidates include
  `media.action.inspect-artifact` and `media.action.inspect-provenance`, but
  step action and operation bindings remain null.
- **Expected effect:** the proposal separates package validity, transport, and
  external publication; successful delivery requires a destination
  acknowledgement/receipt where applicable.
- **Failure/recovery:** partial package, destination rejection, timeout after a
  possible effect, or approval-scope mismatch are explicit exceptions. Reconcile
  by effect/idempotency identity before retry; unknown publication is neither
  success nor failure.
- **Binding gap:** no exact step operation, external-effect authority, or
  accepted destination adapter/acknowledgement fixture.

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
- **Expected effect:** compare a deterministic/procedural or 3D candidate and
  preserve relevant measurements/declared format loss in output review. These
  are proposed journey outcomes, not computed results in this example.
- **Failure/recovery:** source contracts describe comparison and semantic
  validation, but do not provide accepted per-step failure actions or a runtime
  recovery contract for these family examples.
- **Binding gap:** all listed journeys retain null step actions/operations and
  unresolved state/authority bindings; no interchange loss fixture or engine
  qualification is present.

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
  unavailability, and inferred identity treated as proof as exceptions. Exact
  per-condition recovery and retry behavior are not allocated by J-10.
- **Binding gap:** null step action/operation, authority, and transition
  bindings; no source-backed reference-asset fixture proves continuity or
  provenance correctness.

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
  consequential operation merely because a client reconnects.
- **Binding gap:** no source scenario reference for J-23 and no step-level
  action/operation/state/transition allocation; no production offline client
  evidence.

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
  pending; no action or canonical operation is allocated in the journey.

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
  reconciles accepted work, and continues only unambiguous eligible items;
  exact per-condition state/action bindings remain pending.
- **Binding gap:** step action and operation refs are null; no admitted CLI
  host/runtime evidence for this journey.

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
  effect. J-25 has no allocated step actions, canonical operations, or
  per-channel recovery binding, so this is not a runnable request/response
  transcript.
- **Binding gap:** the requested API/SDK/Agent request-response example cannot
  be completed without the missing public operation/owner bindings and fixture
  oracle. Do not infer payload schemas from similarly named transport routes.

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
failed, or final. The route declares no search filters, continuation token,
sort order, or empty/denied/stale-index result distinctions; those remain
unimplemented parts of the Media search contract. The current operation
crosswalk explicitly leaves its PDP-1 logical operation null and owner review
pending, so this example does not make the job-search contract runnable.

## P3-08 coverage and remaining gaps

| P3-08 family | Trace | Current source status / unresolved dependency |
| --- | --- | --- |
| Upload → verify → transcribe/correct | J-02, J-03 | Proposal; real transfer and complete channel coverage pending; J-03 audio-only lane. |
| Versioned caption time edits | J-03 | Proposal; correction operation/state/finality not step-bound. |
| Authorized voice synthesis | J-04 | Proposal; action/state/scenario/channel bindings and owner review pending. |
| Mix/master and loudness | J-17 | Proposal; profile/runtime and measurement oracle pending. |
| Video repair/color/quality | J-08, J-18, J-19 | Proposal; action/state/scenario/channel bindings and quality evidence pending. |
| Approved render/delivery | J-18, J-22 | Proposal; external-effect authority and destination acknowledgement runtime pending. |
| Scene/animation/simulation/interchange loss | J-12–J-15, J-28 | Proposal; engine/codec qualification and loss fixture pending. |
| Generation from references/provenance | J-10 | Proposal; rights/authority and provider bindings pending. |
| Offline conflict | J-23 | Proposal; scenario refs and step bindings pending. |
| Live session loss/reconnect | J-29 | PDP-0-grounded; transport and owner review pending. |
| Headless CLI batch | J-24 | Proposal; executable host and operation bindings pending. |
| API/SDK/Agent bounded result | J-25 | Proposal; typed public binding and runnable fixture oracle pending. |

This batch does not meet P3-08 Done: none of the examples above is an accepted
end-to-end capability, and several families lack step action/operation,
scenario, owner, or runtime evidence. Continue P3-08 as partial until each
selected family has either an accepted traceable example or a reviewed explicit
exclusion. No unqualified provider is described as live.

## Local source checks

Regenerate the product-definition manifest after authored source changes with
`pnpm generate:product-definition-manifest`, then run `pnpm check:product-experience-local`.
The focused P3-08 test checks that family entries trace to existing J-01…J-30
journey contracts and that every listed family declares status, expected effect,
failure/recovery, and any binding gap. It is structural documentation checking,
not semantic acceptance.
