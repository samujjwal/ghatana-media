# Logical surface: `media.surface.interactive-demo-player`

Interactive demo playback channel. The UI state machine and accessible
controls live in `libs/audio-video-ui/src/player/`.

## Supported operations (plan target)

Branching navigation, seek, cue selection, controls, deterministic replay,
host-attested source labeling, keyboard/screen-reader navigation. This
library slice does not fetch or render media assets; it exposes an authored
scene controller. A host must supply trusted bundle verification and an
actual media transport before this can be described as hosted playback.

## States and invariants

- Deterministic branching: seek/replay/branch behavior and half-open caption
  cue selection are reproducible from authored scenario definitions.
- Authored branch IDs are unique within each scene. Duplicate IDs fail bundle
  validation before actions can select an ambiguous branch or render duplicate
  control keys.
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

## Dependencies

`@audio-video/ui`; authored scenario/fixture definitions;
`libs/media-experience-simulation` for deterministic state where
applicable.

## Errors

Cross-origin/unbound operations fail closed; unsupported branches
render explicit unavailable states.

## Tests

Focused tests cover branch replay after seeks, origin-bound allow/deny,
stale asset/caption bindings, malformed actions, cue boundaries, source-truth
labels, and native keyboard-operable/screen-reader controls. The verifier in
tests is a fake authority and is not evidence of a production host verifier
or real hosted media output.
