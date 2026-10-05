# Media Experience Simulation

This package owns deterministic fixture state and transitions for J-01
first-use/project setup, J-02 artifact-intake and verification-job metadata,
and the selected J-03 transcription and caption-correction lane. It does not invoke Shared identity,
a project service, the Media runtime, external providers, or live user data.

Build the TypeScript sources, then run a deterministic workflow fixture:

```sh
pnpm dlx --package typescript@6.0.3 tsc -p libs/media-experience-simulation/tsconfig.json
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

The fixture runner is a Phase 3 inspection entry point. It is not the
`ghatana-media` product command simulator and does not claim that any simulated
capability is implemented or available at runtime.

J-02 upload fixtures contain transfer metadata only. For example, the canonical
command simulator can resume the same interrupted fixture upload identity:

```sh
node libs/media-experience-simulation/bin/ghatana-media.mjs \
  --scenario media.scenario.upload-interrupted \
  upload resume --upload fixture-upload-interrupted-001 \
  --format json
```

The transition preserves the fixture upload ID and acknowledged-part count;
it transfers no bytes and does not create a processing job. The J-01 project
creation action similarly operates only on a synthetic fixture; an unknown
create outcome keeps its original request ID and cannot be blindly retried.
