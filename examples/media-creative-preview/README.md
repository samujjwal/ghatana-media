# Media creative preview

This is a thin local consumer of the existing AnimationRenderer, PcmStemMixer, BoundedPcmDeclipper, AudioRepairComparison, SpatialRigEngine, and PhysicalSimulation APIs. It adds no engine or authority. Run from the Media repository root:

```bash
./gradlew :services:media:examples:media-creative-preview:run
```

In a monorepo build, use `:media:examples:media-creative-preview:run`. Pass an output directory as the first application argument when needed; by default artifacts go to `examples/media-creative-preview/build/media-creative-preview/`.

The example uses a deterministic, locally authored card scene, generated PCM tones, a one-bone rig, and a constant-force solver request. It produces `animation-frame-000.png` through `animation-frame-005.png`, `animation.gif`, `preview.wav`, `interactive-demo-preview.wav`, `original-clipped.wav`, `repaired-candidate.wav`, `preview.glb`, `simulation.json`, and `preview-manifest.json`. `preview.wav` remains a 10 ms (480-frame) mix fixture produced by `PcmStemMixer`; the consumer independently decodes it and checks the exact PCM bytes and SHA-256 against the mix result before publishing the manifest. `audioMix.outputPcmSha256` binds that decoded WAV PCM to the mixer output, while `outputs.wav.sha256` binds the persisted WAV file. `interactive-demo-preview.wav` is a separate deterministic 2-second, 48 kHz stereo PCM16 440 Hz tone for native browser media consumers such as `InteractiveDemoPlayer`; its exact persisted-file SHA-256, filename, source version, and `local-interactive-demo-tone-v1` clock are recorded in the manifest. It is a local test fixture only, not a hosted asset or rights/quality claim. The example also creates a 10 ms synthetic tone whose samples are hard-clipped at the signed PCM limits, passes the immutable clipped source through `BoundedPcmDeclipper`, and snapshots both branches with `AudioRepairComparison`. It independently decodes both repair WAVs with Java Sound and verifies the decoded PCM bytes and hashes against the comparison branches before recording output digests. Before recording GLB lineage, it reopens the persisted `preview.glb` and validates those local bytes with the pinned official Khronos glTF Validator Node package. The manifest records validator version and error/warning/info/hint issue counts; the existing bounded lineage parser remains a separate application-specific check. The animation section of `preview-manifest.json` lists each persisted PNG frame with its SHA-256, fixture source version, exact rational PTS and story ticks; every PNG and GIF frame is independently decoded and GIF timing metadata is checked against the rendered frame clock.

All material is explicitly **local preview only**. The WAV input and clipped fixture are synthetic and do not demonstrate source rights, Foley, mastering quality, certified true peak, or repair quality. Linear interpolation is only a bounded candidate reconstruction assumption; the original clipped WAV is preserved as a separate branch and the candidate is not recovered source truth. No independent reference is supplied, so the manifest makes no SNR or quality claim. The spatial exporter uses only its bounded metre/right-handed/XYZ/unit-quaternion profile and labels float32 approximation; it does not establish general coordinate conversion, 360 rendering, viewer parity, delivery, or a receipt. Simulation JSON is deterministic model output, not instrument or measurement evidence. This consumer is not a hosted Media product and does not imply job finality or completion of J07/J12/J13/J14/J15/J17/J28.

The local preview run and its focused test require Node.js plus the repository's pinned JavaScript development dependencies installed with `pnpm install`. GLB validation uses the pinned [KhronosGroup glTF Validator Node package](https://github.com/KhronosGroup/glTF-Validator/blob/main/node/README.md) `gltf-validator@2.0.0-dev.3.10`. The validator computes SHA-256 over the exact `Uint8Array` it validates; the example compares that digest with the persisted GLB digest before writing the manifest. The fixed local GLB currently produces zero errors, warnings, infos, and hints. Khronos validation establishes glTF structural/specification diagnostics for the generated GLB only; it does not establish rendering, viewer fidelity, coordinate-profile correctness beyond the retained lineage checks, or task/journey completion.

The `LOCAL_PREVIEW_ONLY` manifest records each output's filename, SHA-256 of persisted file bytes, and source version. It records the animation story clock, the fixed 48 kHz stereo `PCM_S16LE` 480-frame output clock, the separate 96,000-frame interactive-demo audio clock, the GLB rig's `FLOAT32_SECONDS` clock, and the simulation's observed second-based range and sample count. It also binds the generated `local-tone-v1`, `local-interactive-demo-tone-v1`, and `local-clipped-tone-v1` PCM lineages, source and repaired PCM digests, WAV artifact digests, the selected declip algorithm/parameters, and the explicit absence of an independent reference. The mix summary distinguishes quantized sample peak from the mixer's estimated inter-sample true peak and labels that estimate as not certified; it is only a local fixture reading. The preview mix additionally verifies exact decoded PCM equality with the mixer's result, and records its PCM digest separately from the enclosing WAV-file digest. Output digests are calculated from files after writing and readback. Change fixtures only as explicitly versioned local inputs. External rights, owner-authored journey bindings, independent measurement, qualified providers, hosted execution, and destination receipts remain outside this preview.

## Caller-provided audio repair preview

For a local PCM WAV you are authorized to process, create separate source and candidate WAVs plus a digest-bound manifest:

```bash
./gradlew :services:media:examples:media-creative-preview:audioRepairPreview \
  -PaudioRepairInput=/path/to/input.wav \
  -PaudioRepairOutput=/path/to/output-directory
```

Use `:media:examples:media-creative-preview:audioRepairPreview` in the repository's direct Media build. The reader accepts signed little-endian PCM16/24/32 WAV with one or two channels, complete frames, and at most 16 MiB decoded PCM. The output argument names a **new destination directory**: its parent must already exist and is resolved to its real path before staging; the destination must not already exist (including as a symlink). The consumer writes `source.wav`, `repaired-candidate.wav`, and `audio-repair-manifest.json` into a hidden sibling staging directory on the same filesystem. It verifies the complete staged bundle, then publishes the directory with one atomic move. Filesystems that cannot perform that atomic directory move fail closed; there is no copy or non-atomic fallback. A process hard-stop can leave private `.audio-repair-staging-*` residue, but the public destination stays absent and a retry can publish to it.

A persistent hidden sibling `.<destination-name>.audio-repair.lock` file coordinates runs targeting the same canonical destination. Its OS file lock serializes concurrent attempts and is released by process termination; the small lock file remains for future coordination. Symlinked reservation files, hardlink aliases, input aliases, and existing destinations fail closed without replacing their targets. The manifest binds input file/PCM digests, output WAV/PCM digests, format/frame count, and descriptive comparison metrics. The source branch is read back byte-for-byte and the input file is never modified. Both persisted WAV branches are independently reopened and checked against the input PCM format, frame count, rounded duration and exact branch bytes before manifest commit. The manifest defines peak as maximum absolute decoded signed sample-code magnitude across channels (sample peak, not true peak). Corrupt or unsupported WAV input fails before publication. Runs use the existing 0.94 threshold and 64-frame bound; edge runs or longer runs fail closed.

Input/output and the three output paths must resolve to distinct files. Existing symlink or hardlink aliases are rejected before either branch is written so the candidate cannot replace the source branch through an aliased path.

This is a caller-provided local operation, not proof that the input is lawful or representative. Near-full-scale detection is only a clipping heuristic, and the candidate uses bounded linear interpolation. There is no independent reference or SNR, perceptual-quality claim, durable project revision, provider admission, hosted job, or source-rights decision.

## Caller-provided stem master preview

The local stem consumer reads existing caller WAV files and applies the bounded `PcmStemMixer`; it does not synthesize Foley. Create a request JSON with exact source version identities and caller-supplied rights declarations, then run:

```bash
./gradlew :services:media:examples:media-creative-preview:foleyStemMasterPreview \
  -PfoleyMixRequest=/path/to/foley-mix-request.json \
  -PfoleyMixOutput=/path/to/new-output-directory
```

The request binds one to sixteen input stems, sample rate, exact frame count, true-peak ceiling, and per-stem gain/pan. Each input must be an existing little-endian PCM16 stereo WAV at that exact rate and frame count; the reader does not resample, trim, pad, or reinterpret a stem. The per-stem `rightsEvidence` fields are passed to `PcmStemMixer`, which rejects missing, malformed, stale, unknown, denied, or wrong-purpose evidence before output. The request example below shows the source fields that must be supplied:

```json
{
  "sampleRateHz": 48000,
  "frameCount": 48000,
  "truePeakCeiling": 0.95,
  "stems": [{
    "path": "foley-footsteps.wav",
    "sourceVersionRef": "asset/footsteps@v3",
    "gain": 1.0,
    "pan": 0.0,
    "rightsEvidence": {
      "decisionRef": "rights/footsteps-mix-v1",
      "purpose": "PCM_STEM_MIX",
      "disposition": "CLEARED",
      "validFrom": "2026-11-09T00:00:00Z",
      "validUntil": "2026-11-10T00:00:00Z"
    }
  }]
}
```

The consumer writes and decodes `foley-master.wav`, then writes `foley-master-manifest.json` with input/output WAV and PCM SHA-256, exact format/frame bindings, gain/pan, and mix observations. Peak observations include the native sample peak, the four-phase FIR grid estimate, and the combined maximum used for the reported Annex 2-based dBTP estimate; the older windowed-sinc estimate remains separately labeled. The measurement identifies its algorithm version and zero-extension edge policy. It is a local estimate, not standards-certified or a proven continuous-time ceiling; no BS.2217 corpus validation is included. Silence has a null dBTP and dBFS RMS. The request and its rights declarations are caller-supplied and unauthenticated: the manifest labels them `CALLER_DECLARED_UNVERIFIED`. This output is a local mix preview only, not evidence of rights clearance, a mastered release asset, canonical project/job persistence, artifact registration, or delivery. Existing output files and output/input aliases are rejected without overwrite. Algorithm basis: [ITU-R BS.1770-5, Annex 2](https://www.itu.int/rec/R-REC-BS.1770-5-202311-I).

## Tests and local evidence

Run the complete example test unit and the consumer from the repository root:

```bash
./gradlew --no-parallel --max-workers=1 \
  -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE \
  -Pghatana.media.compositeScope=FULL \
  :services:media:examples:media-creative-preview:test

./gradlew --no-parallel --max-workers=1 \
  -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE \
  -Pghatana.media.compositeScope=FULL \
  :services:media:examples:media-creative-preview:run
```

The test unit covers persisted animation frames and GIF timing, decoded WAV
lineage, GLB validation and lineage, simulation output, caller-provided audio
repair, and caller-provided stem mixing. The runnable consumer writes its real
outputs beneath the documented build directory and independently reopens
media files before publishing the manifest. These checks establish deterministic
local consumer behavior only. For the broader J-12 scenario boundary and its
remaining owner-bound source, identity, rights, job, durable restart, and
delivery requirements, see the `media.dev.outcome-two-dimensional-animation`
entry in [`remaining-work.json`](../../docs/development/remaining-work.json)
and its mapping in the
[`Usable Surface Delivery Plan`](../../docs/development/USABLE-SURFACE-DELIVERY.md#creative-preview).
