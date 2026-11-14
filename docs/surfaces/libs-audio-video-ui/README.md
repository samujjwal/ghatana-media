# Surface: `libs-audio-video-ui`

Reusable accessible React UI library (`libs/audio-video-ui`,
`@audio-video/ui`). Media-specific components, screens and typed ports
over the canonical Ghatana design system — a UI library, not a deployed
product host.

## Vision, consumers, and non-goals

The library gives Media host applications accessible React projections of
canonical Media contracts. It is consumed by the Experience Explorer and
sibling UI packages. It does not own product runtime, identity, persistence,
provider effects, source rights, human approval, or a deployed host. The package
entrypoint is [libs/audio-video-ui/README.md](../../../libs/audio-video-ui/README.md).

## Responsibility

- **Component families** (`src/components/`): `MediaComponentFamilies`,
  `MediaComponentInputSchemas`, `MediaComponentRuntimeContracts`,
  `MediaComponentSchemaValidation`, `MediaComponentValueTypes`,
  `MediaProgress`, `MediaTaskFlow`, plus family accessibility tests.
- **Screens** (`src/screens/``): `FirstUseProjectScreen`,
  `ArtifactIntakeScreen`, `JobRecoveryScreen`, `TranscriptCaptionScreen`,
  `MediaTaskScreen`, `MediaContractScreen`, `MediaProductRenderer`,
  `MediaActionDispatchGuard`, `MediaLocalActionContracts`.
- **Interactive player** (`src/player/`): `InteractiveDemoPlayer` renders
  host-attested authored media with deterministic branch/replay/seek/caption
  state. Playback uses nonnegative safe-integer millisecond positions and
  does not dispatch product mutations. At the authored scene end, Play is
  disabled and reducer play is a no-op until the viewer chooses a branch or
  replays the scene.
- **Ports** (`src/ports/`): typed host ports — the library binds to a
  host-provided adapter; it does not own runtime state, identity,
  uploads or provider calls itself.
- `TranscriptCaptionScreen` can accept an optional admitted caption-version
  reader. It requests the exact tenant/principal/source-version scope, checks
  every returned row and duplicate identity, discards stale responses, and
  suppresses projected choices while the canonical read is loading or fails.
  A reader/projection scope mismatch is reported as `UNKNOWN`, even if a prior
  read for the reader's old scope was observed.
  This is a read adapter only; it does not admit caption writes, comparison
  actions, transcript generation, or a deployed product route.
- Foundations/hooks/styles consumed by product hosts and sibling UI
  packages (`ai-voice-ui-react` consumes `@audio-video/ui`).
- `DevProjectTimelineWorkspaceScreen` supports owner artifact inspection,
  exact-version clip attachment/removal, and exact-revision reopen in the
  isolated DEV_ONLY workspace. It requires `media:artifact:read` only when
  inspecting/attaching a clip source. Source/story positions are decimal-string
  rational coordinates persisted through the project-head CAS; this UI makes
  no current rights/revocation, decoder-clock, overlap, rendering, Shared
  membership, or production-authority claim. An ambiguous mutation is
  reconciled as this request only when its effect is present in the exact
  direct successor of the recorded CAS base; a matching graph at another
  head remains unresolved and does not enable retry.
- `DevCreativeOutputsPanel` (`outputs: DevCreativeOutputsPort`, DEV_ONLY) drives
  the host creative lanes: audio repair (`POST /dev/v1/creative-outputs/audio-repairs`,
  one exact owner artifact version plus an explicit threshold/maxRunFrames
  profile, nothing defaulted), simulation (`.../simulations`, bounded
  CONSTANT_FORCE/HARMONIC_SPRING scenario with a unit on every quantity and an
  optional declared invariant), spatial GLB (`.../spatial-glb`, rig JSON with
  client-side shape validation) and reopen by id (`GET .../{outputId}`). It
  shows registered output id/version/sha256/size and lineage (exact source
  version; spatial `float32LossFields` and the DEV_ONLY rights decision with
  `productionGrant=false`; a body claiming a production grant, a non-VALID
  simulation or a different source version is refused). Audio metrics are shown
  only as "engine sample statistics", never as quality. Simulation always shows
  `SIMULATED_OUTPUT_NOT_MEASUREMENT`; the unit-labelled observation series is
  rendered from the registered artifact bytes read through the optional port
  `readArtifactContent` (`GET /dev/v1/artifacts/{id}/content`, exact version in
  `If-Match`, token in the Authorization header only) after their SHA-256, size
  and content type are verified; the older unverified `readSimulationDocument`
  is only a fallback, and a port with neither says the series is not displayed.
  Repaired WAV gets an `<audio controls>` preview and a verified Download; GLB
  gets a verified Download only (attachment, no preview). requestId is stable per unchanged
  payload, `200` is shown as replayed vs `201` created, `409` discards the
  identity, `502`/`503`/unknown offer "Retry with the same request identity",
  and typed `422` (nothing-to-repair, unrepairable run, validator
  REJECTED/ABSTAIN findings, spatial refusals), `403` and `404` are text
  alerts with no output. Not covered: playback, GLB viewing, download, approval.
- `DevVerifiedContent` (with `devArtifactContent.ts`: `readVerifiedContent`,
  `DevContentError`, `describeContentFailure`) is the shared preview/download
  control. A registered GIF is shown as `<img>`, an MP4 as `<video controls>`
  and a WAV as `<audio controls>` through blob URLs only after the fetched
  bytes' SHA-256, byte count and content type equal the registered version
  ("Bytes verified against the registered version"); a mismatch is the typed
  `CONTENT_DIGEST_MISMATCH` (also `CONTENT_SIZE_MISMATCH`,
  `CONTENT_TYPE_MISMATCH`) with no preview. Reads are capped at 8 MiB
  (`CONTENT_TOO_LARGE`, refused before fetching when the registered size is
  over; no Range requests); host `404`, `412`, `403`, `416`, `400` and ceiling
  refusals are typed, and Download never saves unverified bytes.
- With an optional `outputs: DevProjectOutputsPort` the same workspace shows a
  DEV_ONLY **Render and review** panel (`DevProjectOutputsPanel`; without a
  port it keeps the truthful "Render engine unavailable" state). Render: the
  exact displayed project head with at least one clip is submitted as GIF or
  MP4 through `POST /dev/v1/projects/{id}/renders` with a requestId that stays
  stable for an unchanged action (so a repeat is a `200` replay, and
  "Retry with the same request identity" resumes after `502`/`503`/unknown).
  It shows registered artifact id, version, sha256, size, exact source
  versions/frame windows and (MP4) the verified encoding block, and reopens
  the render via `GET .../renders/{renderId}`. Typed `409`, `422`
  (`TRACK_KIND_NOT_SUPPORTED`, `RENDER_UNSUPPORTED_*`,
  `SOURCE_FORMAT_NOT_SUPPORTED`, `RENDER_LIMIT_EXCEEDED`, ...), `503
  RENDER_CODEC_UNAVAILABLE`, `502 RENDER_REGISTRATION_FAILED` /
  `RENDER_EXECUTION_FAILED`, `403`/`404` and unknown outcomes are rendered as
  text-labelled alerts with no registered output; a host body that is
  inconsistent with the requested exact revision/format is refused.
  Review: opens a DEV_ONLY case on the displayed revision or the render's
  artifact version (`POST /dev/v1/reviews`), adds comments, and records a
  decision only after an explicit confirmation checkbox. Currentness
  (`CURRENT`/`STALE`/`UNKNOWN`) is re-read from the host when the project head
  moves, STALE disables new decisions, and every view states that a DEV_ONLY
  ACCEPT is **not** human approval (`establishesApproval=false`,
  `humanReviewApproval=false`); a host body claiming approval is rejected.
  Status regions are `aria-live="polite"`; outcomes are conveyed in text.
  Export (advances `media.dev.delivery-export-destination-ack` and
  `media.dev.outcome-acknowledged-delivery` at the UI edge): once a render is registered (created or reopened by id), the panel
  exports that exact artifact version to a destination id through
  `POST /dev/v1/exports` with a requestId that stays stable per
  artifact-version and destination, and reads it back with
  `GET /dev/v1/exports/{requestId}` ("Check again"). "Delivered" is shown only
  for a destination-confirmed body (HTTP 201/200) that carries a destination
  receipt, whose digest equals the render sha256 and whose acknowledged bytes
  equal the artifact size; a body that claims confirmation otherwise is
  rejected. HTTP 202 is always "NOT CONFIRMED, no receipt". Typed `409
  EXPORT_REQUEST_CONFLICT` (identity dropped), `404 DESTINATION_NOT_FOUND` /
  `ARTIFACT_VERSION_NOT_FOUND`, `422`, `403`, `503
  DELIVERY_DESTINATION_UNAVAILABLE` and 502/transport loss (outcome unknown,
  retry with the same request identity) never show delivery. The panel can
  also reopen a known render id or review case id (project-scoped) so a
  reloaded page can resume prior work. Not covered: preview playback of the render, reviewer
  roles or multi-reviewer authority, time-range/ROI annotations in the UI,
  and any product-route admission. Evidence is jsdom unit tests with a fake
  host port; the live-launcher browser journey is driven by the Explorer scripts.

## Public operations

Package exports `.` (index), component/hook/type subpaths via
`dist/`. Consumers supply the port implementations; screens render
authored contracts and dispatch actions through
`MediaActionDispatchGuard`/`MediaLocalActionContracts`.

## Architecture and design

Components reuse Shared design-system semantics; screens compose typed Media
values and host ports; player state remains a deterministic local reducer. The
interactive player renders native audio/video elements, binds the exact
host-attested manifest, checks declared origins, and keeps branches local. It
does not execute bundle code, verify signatures, or mutate a Media project.
Public subpaths are the explicit `exports` entries in
`libs/audio-video-ui/package.json`; source folders without an export mapping
are implementation details.

## Requirements and current-state alignment

The surface must expose keyboard-equivalent controls and truthful runtime
states, guard stale identity and scope, and keep local simulations separate
from live output. The player transcript is derived only from exact authored
caption cues. Its current manifest has no separate visual-description field,
so the renderer must not invent a complete non-verbal visual alternative.
The source-defined behavior and local gap disposition are recorded in the
player-specific review.

## Examples

The focused player contract, local generated fixture, and browser command are
documented in [the logical player guide](../surface-interactive-demo-player/README.md).
The package and DEV_ONLY workspace boundaries are in the
[package entrypoint](../../../libs/audio-video-ui/README.md).

## States and invariants

- Actionable screens route through the canonical SDK/runtime via host
  ports — the library never fabricates job, artifact, provider or
  identity state; loading/refusal/unknown/pending/final states are
  first-class render states.
- Accessibility is enforced by tests (`MediaFamilyAccessibility.test`,
  `shared-control-reuse.test`); components reuse Shared design-system
  controls rather than forking a state model.
- `MediaContractScreen`/renderer tests keep screen output reconciled
  with authored contract fixtures.
- `MediaProductRenderer` exports deeply frozen route-admission and 47-screen
  realization dispositions, including each nested entry. A consumer cannot
  mutate `NOT_ADMITTED`, `LOCAL_SIMULATION`, or `CONTRACT_PREVIEW` into a live
  status at runtime.
- The player fails closed without exact host attestation; source truth is
  labeled explicitly and unverified live evidence is not shown as live output.
  Local preview browser playback is verified against a generated synthetic
  WAV by the persistent loopback consumer; this does not qualify the production
  host or source rights.

## Dependencies and configuration

- Peer/host dependency on the canonical design system and typed client
  contracts; styles via `src/styles.css`.

```bash
pnpm --filter @audio-video/ui typecheck
pnpm --filter @audio-video/ui test
pnpm --filter @audio-video/ui build
```

## Errors

Dispatch guard rejects actions lacking host admission; unsupported or
unbound operations render refusal/unknown states rather than implying
success.

## Tests and commands

Vitest suites colocated with components/screens
(`MediaProductRenderer.test`, `MediaContractScreen.test`,
`TranscriptCaptionScreen.test`, `MediaProgress.test`,
`MediaFamilyAccessibility.test`, `styles.test`,
`shared-control-reuse.test`). Run via the pnpm scripts above.
The source-scope binding helper also has a dependency-free Node selector:
`node --experimental-strip-types --test src/screens/captionVersionReadBinding.test.mjs`.
The current UI Vitest suite passes 181/181 using the strict pinned TypeScript
noEmit check and package build; both pass. The bounded DEV_ONLY project/timeline
browser selector passes with keyboard-only artifact inspection, exact rational
clip attachment, dependent-track removal rejection, and lost-response clip
removal reconciliation without a duplicate mutation. The real-host clip
persistence check is documented with the Explorer surface. The interactive
player browser selector uses generated `interactive-demo-preview.wav` and
pinned Playwright 1.63.0 / Chromium 153.0.8010.12; it passes 5/5 local cases.
These results are `LOCAL_PREVIEW_ONLY`, not production-host or screen-reader
qualification.

## Evidence and change policy

These checks establish local package and fixture behavior only; they do not
establish production host, screen-reader certification, rights, provider
effects, release, or journey acceptance. Keep implementation aligned with the
owning PDP sources, explicit package export map, and behavior tests. Document
unbound behavior instead of adding runtime or public-contract authority.
