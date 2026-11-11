# Surface: `apps-media-experience-explorer`

Media-owned browser client (`apps/media-experience-explorer`, Vite/TS) that
reviews deterministic product scenarios and hosts a separate local DEV_ONLY
project/timeline consumer. The Product, Explore, Specification, Verify and
Tools Review modes remain fixture-backed projections. The separate
`/dev-project-timeline.html` route connects only through its fixed same-origin
loopback Vite proxy to the signed DEV_ONLY Media host; it is not Shared
identity, a production product host, or a processing-provider client.

## Responsibility

- Render the curated first-use, artifact-intake, verification-job,
  transcription-job and transcript/caption simulations across Product,
  Explore, Specification, Verify and Tools Review modes.
- Host the in-browser terminal running registered synthetic
  `ghatana-media` commands against the same fixture state/reducer (paired
  with `libs/media-experience-simulation`).
- Carry the two-pass demo-recording discipline: `EXPLORER_SIMULATED`
  captures show visible simulation disclosure; `PRODUCT_EXECUTED`
  captures require a real authorized host. Mock finality is never business
  evidence.
- Host the explicitly separate DEV_ONLY project/timeline browser flow:
  verified synthetic owner context, request-bound project creation/replay,
  empty timeline revision creation/reconciliation, exact revision reads, and
  accessible scene/track structure and clip edits. For a clip, the user copies
  the exact artifact ID from the existing local intake, reads the exact owner
  artifact using `GET /api/v1/artifacts/{id}` under `media:artifact:read`, then
  attaches or removes its exact artifact-version reference through isolated
  project-head CAS. Source in/out and story start/duration use decimal-string
  rational coordinates. Removal actions read a fresh owner
  head, reject scenes with tracks and tracks with clips before mutation, and
  commit valid removals with the existing expected-head CAS. Exact revision
  restore appends undo/redo successors while preserving immutable history. This
  flow does not establish current rights/revocation, decoder-clock verification,
  overlap semantics, rendered output, Shared membership, or production
  authority. It remains `DEV_ONLY` and does not admit production operations.
- Host the `/dev-artifact-intake.html` DEV_ONLY artifact flow. Before upload
  admission it reads the exact `/dev/v1/artifact-upload-policy` host route;
  the server requires signed DEV_ONLY identity plus `media:artifact:create`
  and returns the runtime's `maximumChunkBytes`. Explorer sends sequential
  chunks capped at 5 MiB and resumes only from observed server byte/index
  positions. The Explorer computes SHA-256 with the pinned incremental
  `@noble/hashes` provider over `File.slice()` streams; each source slice is
  at most 1 MiB and only one bounded slice is read at a time.
  Other hosts may retain the UI's bounded 64 MiB WebCrypto fallback. This
  route is a local host contract outside OpenAPI and does not admit production
  use.

## Public operations

| Entry | Contents |
| --- | --- |
| `src/main.ts` / `product-review.tsx` / `strict-csp-controls.tsx` | App shell and review surfaces |
| `src/specification.ts`, `physical-topology.ts`, `topology-route.js` | Authored-definition projections and routing |
| `src/lifecycle-pack-adapter.js`, `tools-consumer.ts` | Fixture/lifecycle-pack and tool-consumer adapters |
| `src/keyboard-shortcuts.mjs` | Keyboard/a11y shortcuts |
| Vite dev server (`vite.config.mjs`) | Local preview; strict CSP controls page; allowlisted `/dev/v1` and artifact routes proxy only to a configured `127.0.0.1` Media host |

## States and invariants

- Explorer Product/Explore/Specification/Verify/Tools Review state is
  synthetic fixture state; labels keep the simulation disclosure visible.
  The 26 unseeded journeys are explicitly deferred, not classified N/A.
- The local project/timeline page accepts a short-lived signed DEV_ONLY token
  in memory, fixes its base URL to the page origin, and clears credentials on
  disconnect. Server-side signature verification and owner scoping remain
  authoritative. Local evidence from that route does not qualify Shared or
  production identity.
- Clip inspection uses the existing canonical artifact read route and requires
  `media:artifact:read`; timeline edits remain isolated DEV_ONLY CAS operations.
  The clip stores declared rational coordinates and an exact artifact version,
  without rights/revocation evaluation, decoder-clock validation, overlap
  rules, rendering, Shared membership, or production authority.
- The Explorer is not the generic `ghatana-tools` host and not a fifth
  PDP — `.product-experience/` sources remain authoritative.
- The J-03 `EXPLORER_SIMULATED` r2 recording exists as criterion P3-11
  evidence (deterministic simulated state only); the real-product Build
  recording is `NOT_RECORDED` and semantic equivalence `NOT_VERIFIED`.

## Dependencies and configuration

- `libs/media-experience-simulation` for the fixture terminal;
  `specification-artifacts.json` for authored projections; the separate
  project/timeline page uses `@audio-video/client/dev-project-timeline` and
  fixed loopback `/dev/v1` plus its exact allowlisted artifact-route proxy.
  The rest of the Explorer does not acquire backend, Shared identity, or
  provider configuration.
- `@noble/hashes` is pinned to 2.4.0, MIT licensed, and used only for the
  Explorer's incremental browser SHA-256 upload digest. Its published package
  is ESM and supports modern browsers; the package declares Node.js 20.19+ for
  its Node runtime. This upload UI still accepts only artifacts admitted by
  the host's signature verifier; unknown-format input remains a server
  rejection. The local upload policy caps each chunk at the configured host
  bound and the client at 5 MiB, while the end-to-end upload ceiling remains
  2 GiB.

## Errors

Fixture/validation errors surface in the review UI. The local project/timeline
page preserves typed `OUTCOME_UNKNOWN`, conflict, invalid-response, and
scoped-not-found states from its DEV_ONLY client; it never presents a failed
or unobserved mutation as committed.

## Tests and commands

```bash
pnpm --filter @ghatana/media-experience-explorer test
pnpm --filter @ghatana/media-experience-explorer dev
pnpm --filter @ghatana/media-experience-explorer test:dev-project-timeline:browser
pnpm --filter @ghatana/media-experience-explorer build
pnpm --filter @ghatana/media-experience-explorer preview --port 4179 --strictPort
pnpm --filter @ghatana/media-experience-explorer test:visual-regression
```

Build and preview in one terminal. Keep preview running, then invoke
test:visual-regression from another terminal.

Coverage: static scenario/contract reconciliation, CSP, keyboard/a11y and
responsive behavior, correct simulated labeling, and representation of the
defined screens. The local project/timeline browser contract also covers
memory-only credentials, lost-response replay/reconciliation, exact revision
readback, dependent-removal rejection without a mutation, remove-track/remove-
scene successor revisions, restore undo/redo and immutable history, and
disconnect. The keyboard-only clip extension also verifies exact owner artifact
GET and SHA-256 inspection, rational decimal-string edit payloads, dependent
track-removal rejection, and committed-but-lost clip-removal reconciliation
without a duplicate POST. Current Explorer verification is 27 Node tests and 4
Vitest tests, plus typecheck/build. The bounded browser selector passes with
keyboard-only interaction and no pointer events. The separate real-host
Chromium → Vite → Media → PostgreSQL clip restart selector passed 1/1 and is
documented in
`apps/media-experience-explorer/README.md`. Neither fixture nor DEV_ONLY
evidence establishes full 47-screen host acceptance.

The visual-regression command runs the existing real Playwright audit against
the local preview on port 4179, then compares eight rendered screenshots to
the user-selected local references under
`apps/media-experience-explorer/test/visual-references/local-browser-audit-2026-11-10`.
References are pinned by SHA-256 and compared in decoded pixel space with no
resampling or tolerance. A mismatch writes an actionable red/black diff image
and reports exact pixel counts and bounds. These images remain local regression
references; canonical visual references are still NOT_SUPPLIED and independent
visual review remains MANUAL_NOT_VERIFIED. The original user captures and
their hashes remain preserved separately. The responsive phase-selector fix
intentionally changed the desktop and narrow-mobile Specification images;
manifest entries preserve both the original input hash and corrected active
reference hash.

## Design and extension policy

- Keep fixture review modes separate from the local DEV_ONLY consumer. Never
  reuse fixture finality as live operation evidence.
- A local page may use only a fixed same-origin path and explicit loopback
  proxy. It must not accept a user-controlled remote API origin or persist
  bearer credentials in browser storage.
- Reuse the public `@audio-video/client` operation contract and exported UI
  screens. Do not add Explorer-only copies of upload, project, or artifact
  wire schemas.
- A successful upload receipt is byte-storage acknowledgement only. The
  page cannot imply source rights, consent, processing eligibility, provider
  execution, Shared membership, or production admission.

## Current requirements and open work

- Required now: keep simulation disclosures truthful and make the explicitly
  DEV_ONLY project/timeline flow recoverable and exact-readback capable.
- Still open: a complete 47-screen authenticated product host, real Shared
  identity/workspace membership, owner-admitted project edits, human review,
  artifact-to-timeline lineage, and production admission.
- Any additional local upload page is a bounded developer consumer only; it
  does not complete J-02 without its source-authority, rights and qualified
  processing acceptance.

## Evidence

Use the exact test selectors above and the pinned real-host integration test
documented in the app README. Report fixture, DEV_ONLY, local storage, Shared
identity, provider, and production results separately; this surface README is
not a convergence score or lifecycle receipt.
