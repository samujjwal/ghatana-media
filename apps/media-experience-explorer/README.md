# Media Experience Explorer

This Media-owned browser client reviews deterministic first-use,
artifact-intake, verification-job, transcription-job, and transcript/caption simulations. It
provides Product, Explore, Specification, Verify, and Tools Review modes for these slices.
The in-browser terminal runs the registered synthetic `ghatana-media`
commands against the same fixture state and reducer. Its existing Product and
Explore modes are simulations. The separate `/dev-project-timeline.html` page is
a local DEV_ONLY host consumer; it does not connect to Shared identity or a
processing provider and is not the generic `ghatana-tools` Explorer host.

## Two-pass demo recording — Media v1 adopted; cross-repository admission pending

The target PDP-3 standard is to **record the actual frontend-only Explorer scenario with audible narration and synchronized captions using the deterministic, centrally mocked data**, then reuse the **same source-owned scenario, semantic beat IDs and narrative intent** in BUILD to record the real product's business flow. These are **two separate recordings**, with independent source/capture hashes, evidence, review and truth labels:

- `EXPLORER_SIMULATED`: record this app's real Product/Explore or headless view while its central synthetic fixtures run. Show a visible simulation disclosure and never claim login, upload, model execution, saved artifacts or real provider effects.
- `PRODUCT_EXECUTED`: later capture an actual authorized product host, verified state transitions and owner effect/terminal readbacks. Narration may describe a completed result only once actually observed; never reuse mock finality as business evidence.

The Media v1 edition adopts one source-owned J-03 scenario with an actual narrated Explorer capture as criterion P3-11. The Media PDP-3 source standard and decision are in `demo-recording-standard.yaml` and PXD-224. The generic Ghatana/Kernel/Tools/Lifecycle gate and impact review remain pending in those repositories; this Media decision does not retrofit other products or phases. The Build film and semantic equivalence report remain separate evidence.

**Current evidence (2026-10-21):** the J-03 `EXPLORER_SIMULATED` r2 recording exists at [`recording-manifest.json`](../../docs/implementation/evidence/media-pdp3-demo/j03-explorer-simulated-2026-10-21-r2/recording-manifest.json), with seven narrated scenes, synchronized captions and a checksum manifest. It demonstrates deterministic simulated state only. Media source/content-truth review is recorded; voice rights, external publication, formal privacy certification and general film approval are not claimed. It does not establish implementation, Build behavior or PDP closure. The r1 bundle is retained as superseded provenance. The real-product Build recording is `NOT_RECORDED` and semantic equivalence is `NOT_VERIFIED`. The 26 unseeded journeys are explicitly deferred to later Media editions, not classified N/A.

See the [single canonical plan](../../docs/implementation/MEDIA-BUILD-IMPLEMENTATION-PLAN.md#5b-two-pass-pdp-3-explorer--build-product-recording-standard) and [first paired scenario recording profile](../../docs/implementation/MEDIA-EARLY-BUSINESS-DEMO-RECORDING.v1.json).

## Run locally

From the repository root, start the browser client with:

```sh
pnpm --filter @ghatana/media-experience-explorer dev
```

Run the fixed-viewport browser audit and local pixel comparison with:

```sh
pnpm --filter @ghatana/media-experience-explorer test:visual-regression
```

The command builds the current app, starts a loopback preview on an available
port, captures the eight pinned screens, and compares them with the retained
local references. Reports, screenshots, and any pixel-diff images are kept in
a unique temporary directory printed at the end. These user-selected local
references are regression inputs, not canonical design approval; the audit
continues to report screen-reader and independent visual review as manual gates.

The existing Explorer remains a deterministic simulation. A separate local-only
DEV_ONLY project lane is available at
[`/dev-project-timeline.html`](http://127.0.0.1:4178/dev-project-timeline.html)
while that Vite server is running. Start the Media host with the exact `dev`
profile and isolated loopback database settings described in
[`docs/OPERATIONS.md`](../../docs/OPERATIONS.md#dev_only-project-and-timeline-preview),
then mint a short-lived token for `media:project:dev:read`,
`media:project:dev:create`, and `media:project:dev:write`. Paste the raw token
into the page; it stays in page memory and the password field is cleared after
connect. The page reads the host context, creates and safely replays a project
request, adds an empty timeline snapshot, and commits scene and track structure
edits as successor project revisions. Edits read the current owner head and use
its CAS; after a lost response, the page reconciles the exact requested graph
effect before allowing another write. Reading an exact immutable revision
enables restore as a new project head; undo and redo append CAS successors and
keep earlier graph snapshots available. An ambiguous restore response is
reconciled against the owner head before another write is enabled. Vite proxies
only allowlisted `/dev/v1` routes and the exact artifact read/upload routes to
`127.0.0.1:8093`; the browser cannot set a remote host. To attach a clip, first
upload or locate an artifact through the
existing `/dev-artifact-intake.html` local intake flow and copy its exact
artifact ID. In the timeline page, read that exact owner artifact through
`GET /api/v1/artifacts/{id}`; this requires the verified DEV_ONLY identity to
have `media:artifact:read` and the response must match its tenant and principal.
Choose the exact artifact version, then attach or remove the clip through the
isolated project-head compare-and-set (CAS) edit. Source in/out and story
start/duration are decimal-string rational coordinates; the timeline records
them as declared values and creates immutable successor revisions. Reopen the
exact revision after restarting the launcher to verify persistence.

For clip inspection/attachment, add `media:artifact:read` to the short-lived
DEV_ONLY token. The ordinary upload/intake token does not need that permission.

This path is explicitly `DEV_ONLY`. It establishes no current rights or
revocation checks, decoder-clock verification, overlap semantics, rendering,
Shared membership, or production authority, and it is not a production
application route.
Run `pnpm --filter @ghatana/media-experience-explorer
test:dev-project-timeline:browser` for the failure-path browser contract. It
launches this page against a bounded loopback API fixture, including lost
project, timeline, graph-edit, and restore responses, exact-request replay,
owner-head reconciliation without duplicate mutation, track commit, exact
revision readback, undo/redo, immutable history, and disconnect. It does not
invoke a live Media backend.

Offline drafts: below the timeline workspace, the "Offline drafts" panel
(`@audio-video/ui` `DevOfflineDraftsPanel`) saves timeline edits as inert drafts
when the page is offline. Decision, recorded verbatim: "Offline key custody is browser-held: each (tenant, principal, project) gets a non-extractable AES-GCM CryptoKey generated with WebCrypto and stored only as a CryptoKey object in IndexedDB; it never leaves the browser and is never derived from the bearer token. Offline edits are inert encrypted drafts bound to the exact base head revision; nothing is replayed automatically. On reconnect the user must explicitly review each draft; replay first re-reads the project head and current authorization, sends the edit with expectedHeadRevisionId (CAS) and the draft's own requestId, and on REVISION_CONFLICT shows the conflict without auto-merging. A revoked or changed principal/tenant discards access to the drafts (key scope mismatch). Clearing site data loses drafts by design."
The browser selector above also simulates this with Playwright
`context.setOffline`: draft saved offline (no host request, ciphertext at rest,
non-extractable key scoped to the verified tenant and principal), no replay on
reconnect, explicit "Review and replay" then "Confirm replay" sending the CAS
request, and a REVISION_CONFLICT for a head that moved while offline. The
principal comes from the verified host context, never from the token.

"Open existing project" (step 02b, `src/dev-open-project.ts`) reads
`GET /dev/v1/projects/{id}` in the connected owner scope and loads the project
and its current head into the workspace, so a reloaded page can resume a prior
project; `PROJECT_NOT_FOUND`/`PROJECT_ACCESS_DENIED` surface as typed messages
and a read for another tenant, project or non-head revision is refused. In the
workspace, a render or review case can then be reopened by id, and a registered
render can be exported to a destination id (`POST /dev/v1/exports`, read back
with `GET /dev/v1/exports/{requestId}`; both are on the proxy allow-list). The
page says delivered only with a destination receipt; HTTP 202 is NOT CONFIRMED.
The live script also does this after a reload when
`MEDIA_DEV_RENDER_REVIEW_BROWSER_DESTINATION_ID` names a host destination.

Once a project has an exact head revision with clips, the workspace on this page
also drives the DEV_ONLY render (`/dev/v1/projects/{id}/renders`) and review
(`/dev/v1/reviews`) routes through `src/dev-project-outputs-client.ts`, a
loopback-origin, memory-token fetch adapter. The offline browser fixture asserts
the disclosure, disabled-until-clips state and live regions. A real-launcher
Chromium scenario (`test/dev-render-review-live-browser.mjs`, driven by
`MediaDevExplorerRenderReviewLiveIT`; Docker, `MEDIA_DEV_REVIEW_ENABLED=true`,
GIF or MP4 when `GHATANA_MEDIA_FFMPEG`/`FFPROBE` are set) renders the exact
revision through the page (Created HTTP 201, then Replayed HTTP 200, then
reopen), opens a review case, comments, then (as owner) assigns a second DEV_ONLY
principal for APPROVAL: the owner's decision form is disabled ("owner cannot
decide") and a direct owner decision is refused `403 REVIEWER_NOT_ASSIGNED`. A
second browser context connects with the reviewer's own token, opens the case by
id in the standalone "Review a case as an assigned reviewer" panel (no project
access needed; it yields to the workspace review section once a project is
opened, to avoid duplicate controls), comments and records ACCEPT with scope
APPROVAL (shown as `DEV_ASSIGNED_REVIEWER_ACCEPT`, approval disclaimer visible).
Editing the timeline then shows the case STALE with decisions disabled for
both (a direct reviewer decision is `409 REVIEW_SUBJECT_STALE`), then re-reads render and case after a
launcher restart and checks the single durable render artifact in
PostgreSQL/S3. The PNG source is uploaded over HTTP (this page only inspects
artifacts; it has no upload path). The page cannot open an existing project by
id, so after a full reload the render/review panel is verified to start clean
and the durable readback is asserted over HTTP. The Vite DEV_ONLY allow-list
(`artifact-proxy-guard.mjs`) admits the render, review (including assignments and revoke), export and
`GET /dev/v1/artifacts/{id}/content` routes. After a render is registered or
reopened the panel offers a verified preview (`<img>` for GIF, `<video controls>`
for MP4) and Download: the bytes are fetched as a blob through the
`readArtifactContent` adapter (`src/dev-artifact-content-client.ts`; exact version
in `If-Match`, bearer token in a header, never in a URL; 8 MiB cap, no Range
requests) and shown only after their SHA-256 equals the registered one. The dev
server CSP therefore allows `blob:` for `img-src` and `media-src`.

### DEV_ONLY artifact upload recovery

The separate [`/dev-artifact-intake.html`](http://127.0.0.1:4178/dev-artifact-intake.html)
page exercises artifact upload and recovery against the verified DEV_ONLY
host. After a reload, browser memory is empty: reconnect with a short-lived
token, reselect the same file, enter its existing upload ID, then explicitly
inspect the upload. Inspection is a caller-scoped, read-only request. It binds
the selected file digest and original request metadata to the existing upload,
checks the persisted retention duration and the still-unexpired OPEN upload
session, and requires the observed next chunk index to match the contiguous
position in the selected file. Only after all checks pass does the page offer
**Resume from observed upload**; the user must explicitly confirm that action.
Recovery continues the same upload session and ID rather than creating a
duplicate session. Tokens, selected files, and upload IDs remain in page
memory; a reload discards them. The persisted canonical ISO-duration
`retention` session field is separate from the transfer-session `expiresAt`
timestamp.

This path is `DEV_ONLY` and does not establish rights, consent, Shared
membership, production admission, or J-02 acceptance. The real Chromium
recovery selector and catalog guard pass together. The complete focused J-02
source-composite selector set also passes with PostgreSQL and LocalStack
Testcontainers active:

```sh
./gradlew \
  -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE \
  -Pghatana.media.compositeScope=FULL \
  :services:media:integration-tests:test \
  --tests 'com.ghatana.media.integration.MediaDevProjectTimelineRestartIT.realExplorerResumesUploadAfterReloadAndLauncherRestart' \
  --tests 'com.ghatana.media.integration.MediaTestHarnessCatalogTest' \
  --no-daemon --no-build-cache --no-parallel --max-workers=2 --console=plain
```

That browser selector plus the nine catalog checks passed 10/10. The full
focused J-02 run passed 13/13: raw HTTP resume, owner-issued DEV_ONLY SDK
denial/recovery, Explorer artifact upload/inspection/readback, Explorer
same-page reload/restart recovery, and all catalog checks. The browser test
verified persisted `PT720H` retention against requested `P30D`, same-session
recovery at the observed chunk index, explicit confirmation, one completion,
and exact artifact readback. These are local synthetic-media results only;
J-02 remains OPEN.

### Real browser to DEV_ONLY host restart test

The real-host browser test is selected explicitly as an integration test. From
the repository root, run:

```sh
./gradlew \
  -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE \
  -Pghatana.media.compositeScope=FULL \
  :services:media:integration-tests:test \
  --tests 'com.ghatana.media.integration.MediaDevProjectTimelineRestartIT.realExplorerBrowserCreatesReplaysAndReopensExactTimelineAcrossLauncherRestart' \
  --no-daemon --no-build-cache --no-parallel --max-workers=2 --console=plain
```

This selector uses the local DEV_ONLY issuer, real Media launcher, isolated
PostgreSQL, actual Explorer page, Chromium, and same-origin Vite `/dev/v1`
proxy. The browser creates a project, replays its exact original request, adds
an empty timeline, commits a scene and video track from successive observed
heads, restores the exact scene revision as undo, restores the track revision
as redo, and stays open while Java restarts the Media process. It then reopens
the owner project and reads the exact redo head and historical revisions. It uses
Vite's configured loopback port 4178 and fails clearly if that port is occupied.
The test requires Docker and the pinned Playwright 1.63.0 browser runner with its
installed Chromium. It resolves workspace packages first. If those links are
missing in this checkout, the currently qualified host tools are
`/opt/homebrew/lib/node_modules/@playwright/test` 1.63.0 with nested Playwright
and Playwright Core 1.63.0, Chromium revision 1243 / Chrome for Testing
153.0.8010.12, and `/opt/homebrew/lib/node_modules/vitest/node_modules/vite/bin/vite.js`
8.3.0. The runner checks those exact versions and fails on mismatch; it does not
accept an arbitrary global browser or Vite install.
The DEV_ONLY editor can persist exact artifact-version clip references and
declared rational source/story coordinates. This does not verify current
rights/revocation, decoder clocks, overlap behavior, or rendered output, and
establishes no Shared membership or production authority.

**Verification record (2026-11-10):** the real-host Chromium → Vite → Media →
PostgreSQL clip restart test passed 1/1 with zero skips. It reads the exact
owner artifact, attaches and removes a clip, restarts the launcher, and reopens
the exact persisted revision. UI verification passes 178/178, with strict
pinned TypeScript noEmit and build passing. The client timeline SDK passes
53/53, with typecheck/build and packed ESM/CJS/types consumer checks passing.
Explorer verification passes 20 Node tests and 4 Vitest tests, plus
typecheck/build. The bounded browser selector now passes with keyboard-only
interaction and no pointer events. It verifies exact owner artifact inspection
through the Vite proxy, SHA-256 and decimal-string rational clip payloads,
successor revision readback, pre-POST rejection of track removal while a clip
depends on it, and committed-but-lost `removeClip` reconciliation at the exact
owner head without a duplicate POST.

The timeline editor retains the previously documented accessible scene and
track removal behavior: it reads the current owner head, rejects removal of a
scene that still has tracks or a track that still has clips, then commits valid
removals through expected-head CAS. Exact-revision restore continues to append
undo/redo successors while preserving history. Ambiguous edit results remain
UNKNOWN until reconciled against owner state; no duplicate mutation is sent.
Clip references remain DEV_ONLY and establish no rights/revocation,
decoder-clock verification, overlap semantics, rendering, Shared membership,
or production authority.

To typecheck and build the simulation package before using its terminal
executable:

```sh
pnpm dlx --package typescript@6.0.3 tsc -p libs/media-experience-simulation/tsconfig.json
node libs/media-experience-simulation/bin/ghatana-media.mjs \
  --scenario media.scenario.job-outcome-unknown \
  ghatana-media job check-outcome \
  --job fixture-transcription-job-unknown \
  --format json
```

The executable reads and updates only the selected synthetic fixture. It does
not submit jobs, write to a Media service, or call an external provider.

## Current scope

The client opens in Explore mode. Product mode removes Explorer navigation and
is reachable from the product preview; browser history returns to the
workbench. Product mode renders three synthetic first-use routes for J-01,
three artifact-intake views plus one separate verification-job view for J-02,
and four transcript/caption view labels for the selected audio slice of J-03.
Its shared job-detail view covers J-02 verification jobs and J-20 transcription
jobs. Its CLI projection covers J-02 upload inspection and resume, verification
job status and outcome checking, and J-20 transcription-job status viewing,
cancellation, and outcome checking; it never transfers file bytes.
J-01 fixtures hide protected data when
identity or workspace authority is unavailable and keep uncertain project
creation bound to the same request. They do not authenticate users or create
production projects. The J-02 fixtures contain upload and verification-job
metadata only; they do not transfer files, contact an artifact service, or
define production format limits. The PDP-3 registries index 47 canonical screens,
one job-family specialization file, and 30 journeys (28 baseline proposals plus
J-29/J-30 extension contracts). All 47 canonical screens have source-derived
proposal contracts and all 28 baseline journeys have proposal files. All
authored screen action intents now resolve to intent-based proposal action
references, including intent-derived registry entries. Complete action
semantics, capability authority, component interactions, state transitions,
copy, fixtures, wire/channel bindings, and owner review remain open.

Specification mode indexes the generated source manifest and all 47 canonical
screen contracts plus the job-family specialization. It renders the declared
purpose, context, anatomy, states, actions, channel dispositions, and responsive
and accessibility guidance as read-only proposal previews; actions are labeled
as not executable, and the source YAML remains available below each preview.
The record search filters by title and filename. Each selected record also
exposes a deterministic Explorer projection ID, owning phase and authority
class, canonical location, semantic-fingerprint/currentness status, declared
relation authority, and verification status. Lifecycle-generated fingerprints
and currentness remain explicitly pending until their owner binding is available.
These previews make the source contracts inspectable without implementing their
views or closing PDP-2 or PDP-3 acceptance.

The three CLI registries have distinct roles: `cli-command-registry.yaml` is the
authored product command proposal; `cli/command-registry.yaml` describes the
11-command synthetic Explorer simulator; and
`cli/production-command-registry.yaml` describes the separately configured,
read-only production-host query. Similar command names are intentional
crosswalks between those roles, not interchangeable execution authorities.

The Tools Review tab (`#tools-review`) loads the Media package binding and the
actual indexed Product Truth, domain, presentation, screen, journey, action, and
Explorer verification source files. It then loads the scoped Media package
adapter through the public `@ghatana/product-dev-explorer` API and exercises
render, inspect, and dispatch. The deterministic scenario state is explicitly
still a fixture projection. The route reports blockers, absent Lifecycle
currentness and owner acceptance, and raw source authorities; source presence
and package structure validation are not semantic acceptance. The existing
Product and Explore modes remain Media-owned review surfaces. This route does
not establish full PDP-3 acceptance, registry publication, normal workspace
lockfile resolution, or Lifecycle currentness. Product Truth YAML is not
presented as a canonical `ProductDefinition` instance because no such instance
is published in the Media source tree. PDP-2 template/layout bindings to PDP-3
screens remain proposals; candidate Shared screen bodies remain labeled
unadmitted.
The current Tools source contracts are recorded in
[`tools-binding.yaml`](../../.product-experience/explorer/tools-binding.yaml):
Product Definition, Experience Language, Experience Specification, Experience
Package, Explorer Contracts, the headless Product Dev Explorer library, and
Development Traceability. The packed consumer proof and dedicated browser review
route verify local source-snapshot consumption only. In particular, the headless
Explorer library is not itself this Media-owned Vite host, Development
Traceability projects source models but does not construct or resolve the graph,
and the named contracts do not prove Media phase-verification support or host
admission. Tools owner review and the Tools-owned runtime support gap remain
open. See the
[verification matrix](../../.product-experience/explorer/verification-matrix.yaml)
and [open gaps](../../.product-experience/gaps.yaml) for current evidence and
remaining owner reviews.

Run `pnpm check:product-experience-local` from the repository root for the
read-only local invariant check that backs the closure matrix.

Explorer typecheck (`pnpm --filter @ghatana/media-experience-explorer typecheck`, whose `pretypecheck` builds `@audio-video/client` for the type-only imports resolved from its `dist/`) and unit tests: `pnpm --filter @ghatana/media-experience-explorer test` (its `pretest` builds `@ghatana/media-experience-simulation` first, because `test/explorer-fidelity.test.mjs` imports that package's built `dist/`, which is not committed). To run `node --test test/*.test.mjs` directly, first run `pnpm --filter @ghatana/media-experience-simulation build`.

Run `pnpm test:experience-browser` with the Vite preview active on port 4179 to
exercise 31 scenarios, 376 specification artifacts, 47 Product routes, 282
legacy proposal URLs, keyboard navigation, accessibility/layout checks, and
six responsive viewports. The audit writes fixed-viewport screenshots and
`report.json` to `/tmp/media-experience-browser-audit` by default. It is browser
evidence, not a human visual approval or Lifecycle-owned acceptance receipt.

For a self-contained pixel regression, run
`pnpm --filter @ghatana/media-experience-explorer test:visual-regression`. It
builds the current app, starts Vite preview on an available loopback port, runs
the browser audit, and compares eight desktop/narrow-mobile screenshots with the
user-selected local references in
[`test/visual-references/local-browser-audit-2026-11-10`](test/visual-references/local-browser-audit-2026-11-10).
The comparator checks exact decoded pixels (no crop, rescale, or visual
tolerance), reports changed-pixel counts/bounds/samples, and writes diff PNGs
beside the run report in a unique temporary directory. The reference manifest
keeps the original supplied captures and hashes separate from corrected active
references; its history records the responsive-layout fix and the later
source-inventory count update. These references are local regression inputs,
not canonical design approval. Screen-reader and independent visual review
remain manual gates.

These images are local regression references, not canonical design-owner
references. The audit continues to report independent expert visual review as
`MANUAL_NOT_VERIFIED`, canonical visual references as `NOT_SUPPLIED`, and
screen-reader review as `MANUAL_NOT_VERIFIED`. The visual selector does not
complete the 47-route host requirement or change task/admission status. To
accept a deliberate visual change, inspect it, obtain the relevant design
owner's disposition, then update the local reference images and their manifest
hashes together.
# Shared presentation review host

The Explorer mounts the public `@audio-video/ui/screens` exports for four candidate screen bodies through a local review adapter. The Vite aliases resolve those public import specifiers to repository source for local review, with the installed sibling Shared design-system build used only to make the candidate render. This does not admit the screens, qualify the published UI package, or establish a production Web surface. Every mounted screen is labeled **CANDIDATE · NOT ADMITTED** and receives synthetic simulation state and fixture actions.

Legacy Product renderer helpers in the Explorer are not the source for these candidate screens. Source-derived PDP-3 proposals remain read-only Specification previews.

### Local DEV_ONLY audio restoration A/B (J-07)

Open `/dev-audio-restoration.html` while the local Explorer is running, connect a short-lived DEV_ONLY token (memory only) and use `DevAudioRestorationPanel` (`@audio-video/ui`). Name an exact PCM16 WAV version (and optionally a clean reference), choose the typed operations (declip, 50/60 Hz dehum, FFT denoise; loudness normalization is OFF unless ticked) and press "Restore and measure". The host runs a bounded FFmpeg graph into a NEW version (the source is never modified; lineage records the source digest, the exact filter graph, the parameters and the engine version), then measures source against restored (and against the reference): SNR, segmental SNR, clipped samples, noise-floor level and spectral flatness, plus an optional Whisper transcript diff. Every number and the verdict come from the host; with no reference the page says quality is not measured. Both clips are played only after their SHA-256 equals the registered one, through one player that switches A/B at the same position (mouse button or the radio group by keyboard). The proxy guard admits only `GET .../audio/status`, `POST .../audio/restorations`, `POST .../audio/comparisons` and `GET .../audio/outputs/{id}`. Checks: `node --test test/dev-audio-restoration-page.test.mjs`, `pnpm --filter @audio-video/ui test`, the scripted-host Chromium check `pnpm test:dev-audio-restoration:browser` (layout, A/B switch, phone widths, touch targets), and the real-launcher Chromium journey `test/dev-audio-restoration-live-browser.mjs` driven by `MediaDevExplorerAudioRestorationLiveIT` (Docker, real Kokoro/FFmpeg/Whisper).
### Local DEV_ONLY translate and dub

Open `/dev-dubbing.html` while the local Explorer is running, connect a short-lived DEV_ONLY token (memory only) and use `DevDubbingPanel` (`@audio-video/ui`). The admitted target languages, Spanish stock voices, tempo bounds and overflow policies are read from `GET /dev/v1/translations/capabilities`, never hard-coded. Enter an exact speech-transcript version produced by the speech lane: Translate (`POST /dev/v1/translations`, Qwen2.5-VL text-only, segment ids and source-clock times kept) shows editable segments; Save revision (`POST /dev/v1/translations/revisions`) registers the edit as a NEW version; only a saved version can be dubbed (`POST /dev/v1/dubs`). The timing table shows each segment's source window, natural duration, tempo factor, dub duration and fit; a segment that cannot fit is a typed `DUB_TIMING_OVERFLOW` refusal with the host's per-segment fit (nothing is registered or truncated). The dub audio and its Spanish captions are played only after their SHA-256 values equal the registered ones. No voice cloning; output is unreviewed machine translation and synthetic speech. The proxy guard admits only the six translation/dub routes above (plus the existing exact-version content read). Checks: `node --test test/dev-dubbing-page.test.mjs`, `pnpm --filter @audio-video/ui test`, and the real-launcher Chromium journey `test/dev-dubbing-live-browser.mjs` driven by `MediaDevExplorerDubbingLiveIT` (Docker, real Kokoro/Whisper/Qwen, FFmpeg).

### Local DEV_ONLY voice synthesis

Open `/dev-voice-synthesis.html` while the local Explorer is running, connect a short-lived DEV_ONLY token (memory only) and use `VoiceSynthesisPanel` (`@audio-video/ui`). The voices, locales, text limit, licence and attribution notice are read from `GET /dev/v1/speech/capabilities` (the pinned Kokoro-82M manifest), never hard-coded; a model that is not verified disables the form. The synthesized WAV is played only after its SHA-256 equals the registered one, and "Add to timeline" places the exact version on an AUDIO track of a project (created on first use, idempotent by clip id) through the existing project/timeline routes. The proxy guard admits only `GET .../speech/capabilities`, `POST .../speech/syntheses` and `GET .../speech/outputs/{id}` (not transcription). Checks: `node --test test/dev-voice-synthesis-page.test.mjs`, `pnpm --filter @audio-video/ui test`, and the real-launcher Chromium journey `test/dev-voice-synthesis-live-browser.mjs` driven by `MediaDevExplorerVoiceSynthesisLiveIT` (Docker, real Kokoro, FFmpeg): two syntheses (mouse, then keyboard only), verified playback, add to timeline, responsive and focus checks; the Java side then decodes each clip and renders the UI-built timeline to MP4 with an audio stream.
### Local DEV_ONLY video tracking

Open `/dev-vision-tracks.html` while the local Explorer is running, connect a short-lived DEV_ONLY token (memory only) and use `DevVisionTracksPanel` to track an exact uploaded video version (`POST /dev/v1/vision/tracks`) or reopen a registered tracks output by id (`GET /dev/v1/vision/outputs/{id}`). The tracks document and the source video are shown only after both byte streams verify against their registered SHA-256 (through `GET /dev/v1/artifacts/{id}/content`, version in `If-Match`), and the document's source digest must equal its registered lineage. `VisionTrackOverlay` draws the boxes of the sampled frame that governs the playhead (source-pixel SVG viewBox, so boxes scale with the video; `data-sync="exact"` on a sampled frame, `held` between sampled frames) with a labelled box group, a polite status line updated on pause and seek, and a keyboard-operable track list with select and seek. The page is served only by the Vite development host, is not a production build input and has no Explorer navigation link. The proxy guard admits exactly `POST .../vision/tracks`, `POST .../vision/roi-analyses` and `GET .../vision/outputs/{id}`. Checks: `node --test test/dev-vision-tracks-page.test.mjs`, the Vitest suites in `libs/audio-video-ui` (`devVisionTracks`, `VisionTrackOverlay`, `DevVisionTracksPanel`), and the real-launcher Chromium journey `test/dev-vision-tracks-live-browser.mjs` driven by `MediaDevVisionTrackingLiveIT` (Docker, PostgreSQL + S3, real Florence-2 sidecar, FFmpeg-generated video): it asserts the drawn boxes against the analytic ground truth at exact PTS and against the pixels of the presented video frame, restarts the host and reopens, and then proves a revoked right is denied with nothing new registered. Detections are from a local open model and carry no accuracy, rights or approval claim.

Open `/dev-animation.html` while the local Explorer is running, connect a short-lived DEV_ONLY token (memory only) and use `DevAnimationPanel` (`@audio-video/ui`) to author a deterministic 2D scene: canvas size, frame rate and count, shapes (rectangle, ellipse, line, image asset) with keyframes whose easing is one of four curves, and optional image assets named by exact artifact version (an asset needs a processing rights statement by its uploader; the page never states rights). The limits come from `GET /dev/v1/animations/status`. A frame slider and a text description preview the authored curves approximately in the browser (the host render is the only result). Render (`POST /dev/v1/animations/renders`) shows the result only after the host has verified the H.264 MP4 (exact frame count, rational frame rate, per-frame times) and registered it with its frame manifest; the video plays only after its SHA-256 equals the registered one. A typed refusal (invalid scene with the JSON path of the offending value, over budget, missing or revoked asset rights) moves focus to the offending field and renders nothing; pressing Render again for the same scene reuses the request identifier and shows the replay. There is no text primitive (host fonts would break determinism). The proxy guard admits exactly the three animation routes. Checks: `node --test test/dev-animation-page.test.mjs`, the Vitest suite `DevAnimationPanel`, and the real-launcher Chromium journey `test/dev-animation-live-browser.mjs` driven by `MediaDevExplorerAnimationLiveIT` (Docker, PostgreSQL + S3, real FFmpeg): keyboard preview, the typed refusals, a render with an attested asset, playback in a real `<video>` and the browser's own decode of sampled frames compared with the easing math.

Open `/dev-quality-optimization.html` while the local Explorer is running, connect a short-lived DEV_ONLY token (memory only) and use the Quality optimization panel to run a bounded search over real FFmpeg encodes of a video version you own (`POST /dev/v1/quality/optimizations`): name a lineage and the exact artifact and version, choose "smallest file at a minimum quality" or "best quality within a byte budget", a metric (luma SSIM or PSNR) and the CRF and attempt bounds (the host's bounds come from `GET /dev/v1/quality/status`). The result is the host's report, row for row: every attempt with its CRF, bytes, size against the source, SSIM, PSNR and a text verdict (a failed attempt is listed like any other), the chosen attempt marked "Chosen" in text, or the typed abstention ("no attempt met the target"; nothing is chosen, no version is created, no lineage head moves). "Cancel search" stops a running search on the host. The lineage section shows the head version and the append-only head history; "Undo to the previous version" restores the previous head exactly (`POST /dev/v1/quality/lineages/{id}/undo`, with the shown head as the expectation) and "Open lineage" re-reads it from the durable ledger after a restart. Nothing is computed in the browser. The page is served only by the Vite development host, is not a production build input and has no Explorer navigation link. The proxy guard admits exactly the six quality routes. Checks: `node --test test/dev-quality-optimization-page.test.mjs` and the real-launcher Chromium journey `test/dev-quality-optimization-live-browser.mjs` driven by `MediaDevQualityOptimizationIT` (Docker, PostgreSQL + S3, real FFmpeg): keyboard-only entry, the table compared with the host JSON row for row, undo, a typed abstention, cancellation mid-search, a host restart and reopen from the durable ledger. Numbers are luma SSIM/PSNR and carry no perceptual, rights or approval claim.

Open `/dev-region-edit.html` while the local Explorer is running, connect a short-lived DEV_ONLY token (memory only) and use `DevRegionEditPanel` (`@audio-video/ui`) for the J-11 tracked region edit: name a stored video as version 1 of a lineage, then apply a blur, pixelate or fill inside a mask that follows a track produced by this host's own tracking lane (the host refuses an uploaded file that merely claims to be a track). Every edit is a NEW immutable version (`POST /dev/v1/region-edits/lineages/{id}/edits`); the original is never changed. Each edit or undo names the head version the page last saw, so a concurrent change is a typed `STALE_BASE_VERSION` alert with the sent and current versions and a Reload lineage button; the page never retries a stale request on its own, while an unknown outcome retries the same request identifier. Undo (`.../undo`) points at the exact earlier artifact. After a result the page shows the host's verification (every frame time exact, samples outside the mask bit-identical for a lossless encode or a PSNR for the browser-playable preview, samples inside changed), the track's own drift (leave-one-out, no ground truth) and the per-frame mask table; the edited video plays only after its SHA-256 equals the registered one, and an overlay outlines the manifest mask of the frame shown. A typed refusal (untrusted track, revoked or missing rights, invalid field with its path, nothing to undo) renders nothing. The proxy guard admits exactly the status, lineage, edit and undo routes. Checks: `node --test test/dev-region-edit-page.test.mjs`, the Vitest suite `DevRegionEditPanel`, and the real-launcher Chromium journey `test/dev-region-edit-live-browser.mjs` driven by `MediaDevExplorerRegionEditLiveIT` (Docker, PostgreSQL + S3, real FFmpeg and the real Florence-2 sidecar).

Open `/dev-video-comparison.html` while the local Explorer is running, connect a short-lived DEV_ONLY token (memory only) and use `DevVideoComparisonPanel` to measure two exact registered video versions against an optional clean reference (`POST /dev/v1/video/comparisons`) or reopen a registered comparison by id (`GET /dev/v1/video/comparisons/{id}`). The comparison document and both videos are shown only after their bytes verify against the registered SHA-256 (through `GET /dev/v1/artifacts/{id}/content`, version in `If-Match`), and the document's subject digests must equal its registered lineage. `VideoWipeComparison` shows the baseline and candidate as a keyboard-operable wipe slider (value text names both sides) or side by side, keeps the two videos on one clock, steps frame by frame on the exact measured presentation times and announces both subjects' per-frame numbers in a polite status line. The per-frame chart (PSNR, SSIM, noise sigma or Laplacian variance; distinct colours and dash patterns, a text alternative and a full data table) plots exactly the measured values, leaves unmeasured frames as gaps and marks every frame where the candidate is worse than the baseline; a regression is shown like an improvement. The page is served only by the Vite development host, is not a production build input and has no Explorer navigation link. The proxy guard admits exactly `POST .../video/enhancements`, `POST .../video/comparisons` and `GET .../video/{enhancements|comparisons}/{id}`. Checks: `node --test test/dev-video-comparison-page.test.mjs`, the Vitest suites in `libs/audio-video-ui` (`devVideoComparison`, `DevVideoComparisonPanel`), and the real-launcher Chromium journey `test/dev-video-comparison-live-browser.mjs` driven by `MediaDevVideoEnhancementIT` (Docker, PostgreSQL + S3, real FFmpeg, FFmpeg-generated reference): it checks the shown numbers against the registered document, drives the wipe and frame controls by keyboard, compares the presented frames' noise in the browser itself, restarts the host and reopens, and proves a revoked right is denied with nothing new registered. Numbers are luma PSNR/SSIM and no-reference estimates and carry no perceptual, rights or approval claim.

### Local DEV_ONLY provider status

Open `/dev-provider-status.html` while the local Explorer is running, connect a short-lived DEV_ONLY token (memory only) and use `DevProviderStatusPanel` to see which local providers (Whisper, Kokoro, Florence-2, Qwen2.5-VL, FFmpeg) are really usable (`GET /dev/v1/providers/catalog`). Each row shows the observed state as text (`READY`, `DEGRADED`, `UNAVAILABLE`, `NOT_ADMITTED`, `WITHDRAWN`, never colour alone), the stable reason code with a plain explanation, the licence SPDX, the device the provider reported and the check time; a disclosure per provider adds the model revision, verified languages and voices, digests and the licence notice. The panel refreshes live (default every 5 s, switchable, never two requests at once), announces a state change in a polite live region, keeps the last view but marks it stale when a refresh fails, and refuses to show anything as ready when the catalog cannot be parsed. Production eligibility is always shown as "No". The page is served only by the Vite development host, has no Explorer navigation link and its proxy guard admits exactly `GET /dev/v1/providers/catalog`. Checks: `node --test test/dev-provider-status-page.test.mjs`, the Vitest suite `DevProviderStatusPanel.test.ts` in `libs/audio-video-ui`, and the real-launcher Chromium journey `test/dev-provider-status-live-browser.mjs` driven by `MediaDevProviderOutageLiveIT` (Docker, PostgreSQL + S3, real providers): the open page shows the Kokoro worker going `UNAVAILABLE` after the worker process is killed and `READY` again after the next synthesis, without a reload.

### Local DEV_ONLY creative outputs

Open `/dev-creative-outputs.html` while the local Explorer is running, connect a short-lived DEV_ONLY token (memory only), and use the `DevCreativeOutputsPanel` for audio repair, bounded simulation, spatial GLB export and reopen-by-id against `/dev/v1/creative-outputs/*`. The page is served only by the Vite development host, is not a production build input, and has no Explorer navigation link. The proxy guard admits only `POST .../audio-repairs`, `.../simulations`, `.../spatial-glb` and `GET .../{outputId}`. Results are engine outputs under explicit inputs: audio metrics are engine sample statistics, simulation output is `SIMULATED_OUTPUT_NOT_MEASUREMENT`, and the spatial rights decision is a DEV_ONLY owner-scope check with `productionGrant=false`. The simulation observation series table is built from the registered document bytes read through `GET /dev/v1/artifacts/{id}/content` after SHA-256 verification (a mismatch shows no table); the repaired WAV has an audio preview and verified Download, and the GLB has a verified Download only. The guard also admits exactly `GET /dev/v1/artifacts/{id}/content` (no query string; the version travels in `If-Match`). Checks: `node --test test/dev-creative-outputs-page.test.mjs` and `pnpm test:dev-creative-outputs:browser` (fixture host, Chromium via Playwright; proves UI wiring and request identity, not engine behaviour). A real-launcher Chromium journey (`test/dev-creative-outputs-live-browser.mjs`, driven by `MediaDevExplorerCreativeOutputsLiveIT`; Docker, PostgreSQL + S3) seeds a clipped WAV and PNG sources over HTTP, then through this page runs audio repair (verified `<audio>` preview and a download whose SHA-256 is checked independently), a valid simulation (table from verified bytes), a REJECTED simulation (findings, no output registered) and a spatial GLB, restarts the host and reopens each output by id; the render/review live journey likewise previews and downloads the verified render, before and after the restart.

### Local caption correction and review (J-03)

Open `/dev-caption-correction.html` while the local Explorer is running, connect a short-lived DEV_ONLY token (memory only) and use the `CaptionCorrectionEditor` from `@audio-video/ui` to open one exact caption version (the unreviewed Whisper WebVTT or an earlier correction), edit cue text and timing and save a NEW version through `POST /dev/v1/captions/corrections` (lineage to the machine version and to you; the edited version is never overwritten; a stale base is a conflict; an unknown outcome is retried with the same request identity). The editor is keyboard operable: every control is a native input or button, Alt+ArrowUp/Down moves between cue texts and Ctrl/Cmd+Enter saves; problems are reported with `aria-invalid`/`aria-describedby` and a polite status region. The same page embeds the existing `DevReviewSection` bound to the exact caption version: the owner opens a case and assigns a different DEV_ONLY principal, who opens the case by id in their own context and decides. A decision is a DEV_ONLY statement, never an approval. The proxy guard admits exactly `POST /dev/v1/captions/corrections` and `GET /dev/v1/captions/{id}`. Checks: `pnpm --filter @audio-video/ui test` (editor), `node --test test/dev-caption-correction-page.test.mjs`, and the real-launcher Chromium journey `test/dev-caption-correction-live-browser.mjs` driven by `MediaDevExplorerCaptionCorrectionLiveIT` (Docker, PostgreSQL + S3, real Whisper output of `jfk.wav`).

### Local owner-scoped job read

Open `/dev-job-recovery.html` while the local Explorer is running to connect a short-lived DEV_ONLY token and read a known job. The page uses the public `MediaCanonicalClient.getJob` method through the same-origin `GET /api/v1/jobs/{jobId}` proxy; the Media host remains responsible for owner and `media:job:read` authorization. The page does not request a job until the user selects a job ID and presses **Refresh canonical status** in the rendered recovery screen. A denied or unknown read remains explicitly DENIED or UNKNOWN in `JobRecoveryScreen`. This page has no cancel or retry action and does not make provider-finality claims. It also has a **Watch job across a host restart** panel that polls the same read once a second, lists each distinct state it actually read (`RUNNING`, host unreachable, host reachable again, terminal) and shows the provider outcome, reconciliation note and output digest; while the host is down it keeps the last observed state and says it is unavailable. `apps/media-experience-explorer/test/dev-job-restart-live-browser.mjs` drives it in real Chromium for `MediaDevJobRestartRecoveryIT`, across a SIGKILL and restart of the launcher.

The recovery page is served only by the local Vite development host and is excluded from production build inputs. Its proxy accepts one safe job ID with an exact `GET` and no query string; collection reads, writes, cancel paths, encoded separators, and query variants are rejected locally.

The real-host browser assertion is part of `MediaDevIssuerHeadlessRestartIT`. It issues a short-lived test owner identity and diagnostic job, then opens this Vite page against the restarted Media process. The test verifies that the canonical SDK returns the job's tenant, owner, terminal status and version; no job request occurs on screen mount; a token without `media:job:read` renders DENIED; another owner receives UNKNOWN without job status/version disclosure; and all credentialed calls stay same-origin GETs. It also checks keyboard submission, a 375px viewport, browser storage, and absence of cancel/retry requests. This remains local DEV_ONLY engineering evidence; it does not alter production admission or imply provider finality.

### Optional OIDC sign-in (authorization code + PKCE)

When `VITE_MEDIA_OIDC_ISSUER` and `VITE_MEDIA_OIDC_CLIENT_ID` are set for the dev server (see
`deploy/keycloak/README.md`), the DEV_ONLY project page shows "Sign in with identity provider (OIDC)". The flow is
authorization code with PKCE (`S256`, no client secret): discovery and the token exchange go directly to the issuer, whose
exact origin is then added to `connect-src` (nothing else is widened); only the PKCE verifier, state and redirect URI
survive the redirect, in `sessionStorage`, and are removed when the callback is handled. The access token is held in page
memory only and is passed to the same connect path as a pasted DEV_ONLY token; the host verifies it on every request and
decides what it is worth. No new Media routes are used, so `artifact-proxy-guard.mjs` is unchanged. Without those
variables the option is hidden and the DEV_ONLY path is unchanged.

Open `/dev-delivery.html` while the local Explorer is running, connect a short-lived DEV_ONLY token (memory only), enter a request id, the exact artifact id and version and a registered destination, and Export (`POST /dev/v1/exports`). The page shows the ACK state as text and border style (not colour alone): DELIVERED only after the destination returned a signed receipt for the exact bytes that Media verified; UNKNOWN when it has not (with a typed failure such as CREDENTIAL_REVOKED, ACK_SIGNATURE_INVALID, DESTINATION_IDENTITY_MISMATCH, CHECKSUM_MISMATCH or DESTINATION_UNREACHABLE); NOT_DELIVERED when the destination verifiably holds nothing. "Refresh status" reads `GET /dev/v1/exports/{id}`; "Reconcile (read destination only)" and "Reconcile and resume" call `POST /dev/v1/exports/{id}/reconcile` with `{"resume":false|true}` and never upload bytes the destination already holds. Destinations are controlled local receivers only; no rights, approval or production claim. The proxy guard admits exactly the export, read and reconcile routes. Checks: `node --test test/dev-delivery-page.test.mjs` and the real-launcher Chromium journey `test/dev-delivery-live-browser.mjs` driven by `MediaDevExplorerDeliveryLiveIT` (Docker, PostgreSQL + S3, independent signed-ACK receiver with injected lost ACK, revoked credential and checksum mismatch).

Open `/dev-erasure.html` while the local Explorer is running, connect a short-lived DEV_ONLY token (memory only) and use `DevErasurePanel` to review the exact tree an erasure would remove (`GET /dev/v1/erasure-plans/{id}`), place or release an owner legal hold (`POST /dev/v1/legal-holds`, `.../{holdId}/release`) and erase (`POST /dev/v1/erasures`) only after a checkbox and the typed root artifact id confirm it; Escape cancels and returns focus to the trigger. The receipt (`GET /dev/v1/erasures/{id}`) lists what was removed by kind and count with the digests of the removed objects and never shows content. Erasure is not the same as revoking rights. The proxy guard admits exactly the plan, erasure, receipt and hold routes (no DELETE, no query string, so the hold listing is API-only). Checks: `node --test test/dev-erasure-page.test.mjs`, the Vitest suite `DevErasurePanel` in `libs/audio-video-ui`, and the real-launcher Chromium journey `test/dev-erasure-live-browser.mjs` driven by `MediaDevExplorerErasureLiveIT` (Docker, PostgreSQL + S3, real FFmpeg render): hold, release, keyboard confirmation, erase, direct S3/PostgreSQL/HTTP readback, host restart and receipt reopen.

### Resumable upload and versions (J-02)

Open `/dev-resumable-upload.html`, connect a short-lived DEV_ONLY token (memory only), pick a real audio or video file and a lineage name. The page hashes the file in the browser, opens (or finds, by an idempotency key derived from the file digest) the upload session, and sends chunks (256 KiB to 1 MiB, bounded by `GET /dev/v1/artifact-upload-policy`), each with an `X-Chunk-SHA256` header that the host verifies before appending (a mismatch is a typed 422 `CHUNK_CHECKSUM_MISMATCH` and nothing is appended). The `<progress>` bar shows only server-acknowledged bytes. Pause stops after the current chunk; Resume, a lost host or a page reload with the same file always re-read the session and continue from the server's `nextChunkIndex`, so no acknowledged chunk is re-sent. After the host verifies the whole-file SHA-256 and size, the page registers the artifact as the next immutable version of the lineage (`POST /dev/v1/intakes`: ffprobe duration and per-stream codecs are recorded; identical content dedupes to the existing version) and lists versions with parent links and the live `PROCESSING` admission verdict of each exact version. Registering grants nothing: "State rights for latest version" records a statement by the signed-in DEV_ONLY identity (`POST /dev/v1/rights/attestations`) and only then does that version read as usable; a revised version needs its own statement. Checks: `node --test test/dev-resumable-upload-page.test.mjs`, and the real-launcher Chromium journey `test/dev-resumable-upload-live-browser.mjs` driven by `MediaDevExplorerResumableUploadLiveIT` (Docker; the launcher is SIGKILLed mid-upload and restarted). The host side needs `MEDIA_DEV_INTAKE_ENABLED=true`, `MEDIA_DEV_RENDER_FFPROBE` and `MEDIA_RIGHTS_DEV_ENABLED=true`.

Open `/dev-simulation.html` while the local Explorer is running, connect a short-lived DEV_ONLY token (memory only) and author a scientific simulation: a model (Newton constant force, damped spring, projectile with no, linear or quadratic drag), the initial state, the solver policy (adaptive or fixed step, tolerances, step and iteration budgets, stop at ground impact), an optional declared constraint and an optional MP4 animation. Every quantity is a number plus a unit chosen from a grouped list; the host (not the page) checks that the unit has the right dimension, so a wrong unit is a typed 422 whose JSON path becomes the focused field. A non-finite number is named and never sent. The host's result is shown only as stored: the final observables, the verification (accepted steps, largest error ratio, energy law and drift, model domain, constraints) and a trace table; the plot (and the animation after an explicit load) appears only after its SHA-256 equals the registered one. A pass the host cannot trust is shown as abstained, with typed reasons and solver counters and no value, trace or plot. Pressing Run again for the same scenario reuses the request identifier and shows the replay; a stored result can be reopened by id. The proxy guard admits exactly the three simulation routes. Checks: `node --test test/dev-simulation-page.test.mjs` and the real-launcher Chromium journey `test/dev-simulation-live-browser.mjs` driven by `MediaDevExplorerSimulationLiveIT` (Docker, PostgreSQL + S3, real FFmpeg): the spring result and the browser's own decode of the plot against the closed form, the typed refusals, both abstentions, replay, reopen, a projectile whose impact time and range match an independent RK4 reference in the browser, and playback of the verified MP4.
