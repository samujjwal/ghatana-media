# Logical surface: `media.surface.interactive-demo-player`

Interactive demo playback channel. The UI state machine and accessible
controls live in `libs/audio-video-ui/src/player/`.

## Supported operations (plan target)

Branching navigation, seek, cue selection, controls, deterministic replay,
host-attested source labeling, keyboard/screen-reader navigation, and a
caption transcript with keyboard-operable cue timestamps that seek to the
corresponding authored media time. Each authored
scene can declare `asset.mediaKind` as `audio` or `video`; omitted kinds retain
the legacy video behavior. The player selects the matching native `<audio>` or
`<video>` element and applies the same source-bound controls, authored clock,
caption seeking, and anonymous CORS policy. `mediaKind` must be an own data
property; accessor-backed, inherited, or unknown values fail bundle validation
without evaluating a getter.

The persistent local preview browser suite verifies decoding and playback of
the generated synthetic WAV. This does not establish a trusted production
host, authorized source rights, or hosted playback. A host must supply trusted
bundle verification and serve media under the declared origin policy before
this can be described as hosted playback.

## States and invariants

- Deterministic branching: seek/replay/branch behavior and half-open caption
  cue selection are reproducible from authored scenario definitions.
- Authored branch IDs are unique within each scene. Duplicate IDs fail bundle
  validation before actions can select an ambiguous branch or render duplicate
  control keys.
- Caption cue IDs are unique within each scene; duplicate IDs fail bundle
  validation before playback because the cue identity would be ambiguous.
- Simulation content is visibly declared — never presented as live
  product behavior. “Live output” is shown only when a trusted host
  attestation matches the exact manifest digest, readback evidence, source
  revision, permissions and actual embedding origin.
- Origin policy is checked against the attested host origin. Cross-origin
  assets/captions require exact-origin scoped capabilities. The view does
  not perform requests, verify signatures or infer its own embedding origin.
  A real host verifier remains an integration requirement.
- Accessibility (keyboard, screen reader) and responsive behavior are
  required, test-enforced properties.
- The transcript may expose only text in caption cues bound to the exact asset
  version. The manifest currently has no separate authored visual-description
  field. The renderer must not infer visual descriptions from pixels or scene
  labels; a complete non-verbal alternative needs owner-defined source data and
  acceptance semantics.

## Dependencies

`@audio-video/ui`; authored scenario/fixture definitions;
`libs/media-experience-simulation` for deterministic state where
applicable.

## Errors

Cross-origin/unbound operations fail closed; unsupported branches
render explicit unavailable states.

## Tests

`pnpm test:interactive-demo-player-state` runs dependency-free state tests for
audio-kind acceptance, the omitted-kind legacy video contract, invalid-kind
rejection, branch replay, origin-bound allow/deny, stale asset/caption
bindings, malformed actions, cue boundaries, and source-truth labels.

The persistent consumer uses the generated
`examples/media-creative-preview/build/media-creative-preview/interactive-demo-preview.wav`
fixture (2,000 ms, 48 kHz stereo PCM16), whose persisted-byte SHA-256 is
`e4695a4f1140ab1d5d7e0964f4c1b07a98f45c9475573c3aa530ded2d216f283`.
Generate it and run the browser selector with:

```bash
./gradlew :services:media:examples:media-creative-preview:run
pnpm --filter @audio-video/ui test:interactive-demo-player:browser
```

The browser selector passes 5/5 cases with Playwright 1.63.0 and pinned
Chromium 153.0.8010.12. It verifies native WAV decode/playback, keyboard
controls, seek/caption correspondence, branching/replay, and fail-closed
origin behavior in a loopback-only Vite consumer. `pnpm test:interactive-demo-player-state`
passes 22/22. The focused player suite passes 24/24, and full UI Vitest passes
181/181 using the lock-pinned Vitest 4.1.11 binary; UI typecheck and build pass.
The focused Gradle creative-preview generator
selector passes 3/3 on its rerun, and the example `run` command emits the
manifest and media outputs consumed by the browser test.

All of this evidence is `LOCAL_PREVIEW_ONLY`. The generated synthetic tone and
local test verifier establish no production host verifier, rights, hosted
playback, screen-reader qualification, GLB viewer, or canonical
project/artifact binding.
