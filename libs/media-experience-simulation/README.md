# Media Experience Simulation

This package owns deterministic fixture state and transitions for J-01
first-use/project setup, J-02 artifact-intake and verification-job metadata,
and the selected J-03 transcription and caption-correction lane. It does not invoke Shared identity,
a project service, the Media runtime, external providers, or live user data.

Build and test through the declared package scripts, then run a deterministic workflow fixture:

```sh
pnpm --filter @ghatana/media-experience-simulation build
pnpm --filter @ghatana/media-experience-simulation test
node libs/media-experience-simulation/bin/media-experience-fixture.mjs \
  --scenario media.scenario.job-outcome-unknown \
  --action '{"type":"media.action.check-job-outcome"}' \
  --format json
```

The CLI uses the same reducer as the exported JSON projection. Repeat
`--action` or `--event` to replay a deterministic sequence. `--format jsonl`
prints one record per step plus a final summary; `--format human` prints a
concise terminal view. A blocked action preserves the current state and
reports its stable reason code.

The selected J-03 fixture lane currently covers audio sources. The parent J-03
journey also includes video, but video audio-extraction and source-time mapping
are outside this lane. J-01 identity/project setup and J-02 upload and
verification-job fixtures carry synthetic project, transfer, job, or evidence
metadata only. Upload, artifact-verification job, and transcription job
identities remain separate projection fields.

The fixture runner and command simulator use distinct names from the
authenticated production CLI. `media-experience-command-simulator` only runs
deterministic fixture transitions; it never calls the Media runtime and does
not claim that any simulated capability is implemented or available at runtime.
The canonical production CLI is `ghatanamedia-api` from
`@audio-video/client`; it uses authenticated canonical SDK operations. Its
capture and recorder command identities return typed `NOT_ADMITTED` until
those execution contracts exist.

## Shared Recorder and Explorer scenario contract

`createScenarioReplayContract`, `validateScenarioReplayContract`,
`advanceScenarioReplayClock`, and `resetScenarioReplayClock` provide one
source-bound envelope for authored Recorder scenarios and Explorer fixtures.
Bind `scenarioId` and `sourceRef` to the owning PDP record, and provide the
exact source/fixture clock identity, tick rate, and starting tick. The seed is
stable for the same scenario/source pair; it is an identifier, not a random
generator seed, integrity proof, solver input, or model output.

The validator requires the explicit `SIMULATED_FIXTURE_ONLY` label,
`dispatch: NEVER`, `networkEffects: NEVER`, no model/solver output, no owner
evidence, and `runtimeAdmission: NOT_ADMITTED`. Unknown or malformed fields
fail validation. Clock advance and reset use only supplied whole ticks; they
never read the wall clock. This contract creates no fixture payload and makes
no runtime, provider, scientific, or owner-acceptance claim.

Source bindings remain owned by
`.product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml`
and `.product-experience/explorer/scenario-fixtures.yaml` for Explorer, and
`recorder-studio-experience.yaml#surfaceCaseScenarioContracts` for Recorder.
The package exposes reusable validation; these source records and consumer
adapters remain the authorities for exact identities and payloads.

J-02 upload fixtures contain transfer metadata only. The fixture command
simulator can inspect the same interrupted upload identity:

```sh
node libs/media-experience-simulation/bin/media-experience-command-simulator.mjs \
  --scenario media.scenario.upload-interrupted \
  upload inspect --upload fixture-upload-interrupted-001 \
  --format json
```

The transition preserves the fixture upload ID and acknowledged-part count;
it transfers no bytes and does not create a processing job. The J-01 project
creation action similarly operates only on a synthetic fixture; an unknown
create outcome keeps its original request ID and cannot be blindly retried.
