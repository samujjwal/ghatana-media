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
reopen), opens a review case, comments, confirms and records a DEV_ONLY
decision with the approval disclaimer visible, edits the timeline to show the
case STALE with decisions disabled, then re-reads render and case after a
launcher restart and checks the single durable render artifact in
PostgreSQL/S3. The PNG source is uploaded over HTTP (this page only inspects
artifacts; it has no upload path). The page cannot open an existing project by
id, so after a full reload the render/review panel is verified to start clean
and the durable readback is asserted over HTTP. The Vite DEV_ONLY allow-list
(`artifact-proxy-guard.mjs`) admits the render and review routes. No export or
delivery is offered.

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

### Local DEV_ONLY creative outputs

Open `/dev-creative-outputs.html` while the local Explorer is running, connect a short-lived DEV_ONLY token (memory only), and use the `DevCreativeOutputsPanel` for audio repair, bounded simulation, spatial GLB export and reopen-by-id against `/dev/v1/creative-outputs/*`. The page is served only by the Vite development host, is not a production build input, and has no Explorer navigation link. The proxy guard admits only `POST .../audio-repairs`, `.../simulations`, `.../spatial-glb` and `GET .../{outputId}`. Results are engine outputs under explicit inputs: audio metrics are engine sample statistics, simulation output is `SIMULATED_OUTPUT_NOT_MEASUREMENT`, and the spatial rights decision is a DEV_ONLY owner-scope check with `productionGrant=false`. The host has no content route, so the simulation observation series is not displayed here. Checks: `node --test test/dev-creative-outputs-page.test.mjs` and `pnpm test:dev-creative-outputs:browser` (fixture host, Chromium via Playwright; proves UI wiring and request identity, not engine behaviour).

### Local owner-scoped job read

Open `/dev-job-recovery.html` while the local Explorer is running to connect a short-lived DEV_ONLY token and read a known job. The page uses the public `MediaCanonicalClient.getJob` method through the same-origin `GET /api/v1/jobs/{jobId}` proxy; the Media host remains responsible for owner and `media:job:read` authorization. The page does not request a job until the user selects a job ID and presses **Refresh canonical status** in the rendered recovery screen. A denied or unknown read remains explicitly DENIED or UNKNOWN in `JobRecoveryScreen`. This page has no cancel or retry action and does not make provider-finality claims.

The recovery page is served only by the local Vite development host and is excluded from production build inputs. Its proxy accepts one safe job ID with an exact `GET` and no query string; collection reads, writes, cancel paths, encoded separators, and query variants are rejected locally.

The real-host browser assertion is part of `MediaDevIssuerHeadlessRestartIT`. It issues a short-lived test owner identity and diagnostic job, then opens this Vite page against the restarted Media process. The test verifies that the canonical SDK returns the job's tenant, owner, terminal status and version; no job request occurs on screen mount; a token without `media:job:read` renders DENIED; another owner receives UNKNOWN without job status/version disclosure; and all credentialed calls stay same-origin GETs. It also checks keyboard submission, a 375px viewport, browser storage, and absence of cancel/retry requests. This remains local DEV_ONLY engineering evidence; it does not alter production admission or imply provider finality.
