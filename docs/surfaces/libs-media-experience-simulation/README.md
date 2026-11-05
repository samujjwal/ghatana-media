# Surface: `libs-media-experience-simulation`

Deterministic fixture state and transitions for Media experience
scenarios (`libs/media-experience-simulation`, TypeScript). It powers the
Explorer's synthetic journeys and CLI fixture terminal — it does not
invoke Shared identity, a project service, the Media runtime, external
providers, or live user data.

## Responsibility

- Own fixture state machines and reducers for the selected lanes:
  J-01 first-use/project setup, J-02 artifact-intake and
  verification-job metadata, and the selected J-03 transcription /
  caption-correction lane (audio sources; the parent J-03 video lane is
  out of scope — video audio-extraction and source-time mapping are not
  covered).
- Export the JSON projection and the `ghatanamedia-api` /
  `media-experience-fixture` CLIs that replay deterministic
  `--scenario`/`--action`/`--event` sequences through the same reducer.

## Public operations

| Entry | Contents |
| --- | --- |
| `bin/ghatanamedia-api.mjs` (`ghatanamedia-api` package bin) | Fixture CLI used by the Explorer terminal |
| `bin/media-experience-fixture.mjs` | Scenario/action/event replay CLI (`--format json|jsonl|human`) |
| Exported reducer/fixture modules (`src/`) | Deterministic state transitions consumed by the Explorer |
| `scenario-replay-contract.ts` exports | Shared strict schema validation and source-clock replay helpers for Recorder and Explorer scenario envelopes |

## States and invariants

- Deterministic: identical scenario+action sequences produce identical
  state; a blocked action preserves current state and reports a stable
  reason code.
- Fixture identities stay separate projection fields (upload,
  artifact-verification job, transcription job are distinct).
- Synthetic project/transfer/job/evidence metadata only — never real
  provider effects, saved artifacts or business finality.
- Scenario replay contracts bind stable source IDs and an explicit clock;
  fixture labels remain `SIMULATED_FIXTURE_ONLY`, with no dispatch, network,
  owner evidence, solver output, model output, or runtime admission.
- The seed is a repeatable source-pair identifier, not a random generator,
  integrity proof, or scientific result. Clock operations advance/reset only
  explicit whole ticks and never consult wall time.

## Dependencies and configuration

- TypeScript sources compiled with `tsc -p tsconfig.json`; consumed by
  `apps/media-experience-explorer`. The exported scenario contract is shaped
  for both Recorder and Explorer adapters; its source-bound inputs remain
  owned by their respective PDP records. No backend or provider configuration.

## Errors

Blocked actions return stable reason codes in the projection/CLI output;
no runtime error taxonomy (no runtime is contacted).

## Tests and commands

```bash
pnpm --filter @ghatana/media-experience-simulation build
pnpm --filter @ghatana/media-experience-simulation test
node libs/media-experience-simulation/bin/media-experience-fixture.mjs \
  --scenario media.scenario.job-outcome-unknown \
  --action '{"type":"media.action.check-job-outcome"}' --format json
```

Coverage: deterministic replay, blocked-action reason codes, scenario
projection parity between CLI and exported JSON, malformed shared scenario
contracts, repeatable seed identity, explicit clock reset/advance, and strict
simulation-only truth fields.
