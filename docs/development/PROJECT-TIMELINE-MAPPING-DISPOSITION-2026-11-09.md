# Project and timeline revision mapping

**Disposition:** user-authorized coordinator semantic choice for implementation<br>
**Date:** 2026-11-09<br>
**Acceptance effect:** none; independent PDP-1 review remains open and runtime admission remains `NOT_ADMITTED`.

## Decision

A `ProjectRevision` owns a list of immutable timeline snapshots. A newly created
project has one committed initial revision with an empty timeline list. An
explicit timeline-creation operation adds an empty timeline snapshot to a
successor project revision. Each snapshot carries a stable `timelineId`, an
opaque `semanticVersionId`, and the exact immutable timeline graph.

A timeline edit keeps `timelineId`, creates a new `semanticVersionId`, and
appends one successor `ProjectRevision` through compare-and-set on
`Project.headRevisionId`. Unchanged timelines retain their semantic version.
Revision history, diff, undo, and redo operate on the complete project
snapshot, so there is one authoritative revision head and no independent
timeline writer. Restoring historical content creates a successor project
revision; timeline content that differs from the current head receives a new
semantic version.

## Rationale

This preserves the PDP-1 requirement that project creation starts with zero
timelines while giving a timeline a real project-owned versioned identity.
It also makes the editing graph persistable without treating an editor handle
as the project revision or inventing a default timeline during project create.
Multiple timelines are explicit members of a project revision, ordered
deterministically by `timelineId` where a local representation needs list order.

## Boundaries

The selected mapping does not define overlap or transition policy, Shared
workspace membership, production storage admission, or a public wire
operation. The PostgreSQL V030 schema remains test-resource-only. A separate
DEV_ONLY local host path is now implemented with an isolated `media_dev_*`
schema and dedicated migration location. It does not use Shared membership,
add a public wire operation, alter production routes, or change formal task/PDP
status. The focused engine and provider checks establish local implementation
behavior only. Do not advance formal task or PDP status from this disposition.

## Addendum — exact timeline graph field mapping (2026-11-22)

**Disposition:** accepted delegated technical product-owner decision for the bounded J01 source definition.<br>
**Rationale:** bind the already-selected empty-project/explicit-timeline revision model to the implemented immutable graph fields, while keeping project and timeline version identities separate and leaving unowned timing/editing policies undefined.<br>
**Acceptance effect:** none; this is not independent review or phase acceptance. Independent PDP-1 review remains open and runtime admission remains `NOT_ADMITTED`.

`ProjectRevision.timelines[]` contains zero or more immutable `TimelineSnapshot` values. Each snapshot has
`semanticVersionId` and `graph`; `graph` has `timelineId`, `scenes[]`, `tracks[]`, and `clips[]`. The project
identity and revision identity remain separate from timeline identity and timeline semantic version. Project
creation commits its initial revision with zero timeline snapshots. Explicit timeline creation adds a snapshot
whose graph has zero scenes, tracks, and clips in a successor project revision. The explicit empty graph is not
an implicit project-create default.

The graph fields are `Scene(sceneId, order)`, `Track(trackId, sceneId, kind, order)` with kind `VIDEO`, `AUDIO`,
`CAPTION`, or `OVERLAY`, and `Clip(clipId, sceneId, trackId, source, sourceIn, sourceOut, storyStart,
storyDuration)`, where `source` is the exact `(artifactId, artifactVersionId)` pair. Every rational time has
`(ticks, rateNumerator, rateDenominator, clock)`. Source interval values use `SOURCE_PRESENTATION`; story start
and duration use `STORY`. Ticks are nonnegative, rates positive, source interval strictly increases, story duration
is positive, and the story end must be exactly representable. IDs and ordering values are unique in their declared
scope. Tracks must reference a graph scene; clips must reference an existing track and the same scene as that
track. Canonical list order is scenes by `(order, sceneId)`, tracks by scene order then `(order, trackId)`, and
clips by scene order, track order, story start, then `clipId`.

The mapping does not define source-to-story clock conversion or rate mapping, overlap or transition policy, playback
semantics, renderability, rights clearance, or persistence/wire admission. Negative cases include silently inserting
a timeline at project creation; equating `semanticVersionId` with `ProjectRevision.revisionId`; duplicate or detached
nodes; cross-scene clip/track references; wrong clock domains; nonpositive intervals; unrepresentable story ends; and
inferring overlap or transition behavior. These are negative acceptance cases for this mapping: any such input or implication
must be rejected or remain undefined until its owning product authority defines it. The executable shape is observed in
`runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaProjectTimelineContracts.java`; this reference
supports the field mapping and does not claim runtime or storage parity.

## Addendum — source use for DEV_ONLY project rendering (2026-11-22)

**Disposition:** accepted delegated technical product-owner decision for the exact project-render source-use boundary.<br>
**Rationale:** an immutable source reference identifies the intended bytes but does not grant permission to consume them. A render reads and decodes source bytes and registers a new output, so each is a distinct governed effect requiring current source-use authority.<br>
**Acceptance effect:** none; this decision is not independent review, phase acceptance, rights qualification, or runtime admission. Independent PDP-1 review remains open; the DEV_ONLY route remains `NOT_ADMITTED` for source-consuming render until the exact authority is available; production remains `NOT_ADMITTED`.

Graph edits may retain an exact immutable `(artifactId, artifactVersionId)` reference without reading source bytes or asserting rights. Before a render reads or decodes any referenced source, it must resolve a trusted binding of tenant, workspace, authenticated principal, project, exact project revision, timeline and semantic version, target/effect, and each exact artifact ID, immutable version, and SHA-256. The version and digest must identify the same bytes. Current effect-specific source rights and policy must authorize that complete binding. The same binding and current authority must be revalidated immediately before registering the rendered output. Authorization for source read/render does not implicitly authorize output registration; the output operation remains separately checked by its existing artifact boundary.

Missing, unavailable, unknown, revoked, stale, conflicting, expired, or cross-tenant/workspace/principal/project/revision/timeline/target/artifact/version/digest authority must prevent source read, decode, render, and output registration. Such outcomes remain `UNKNOWN` or blocked; a source reference, DEV_ONLY label, local ownership, or artifact-read/create permission is not source-use authority. Revalidation must use the exact pre-read binding, not a newly inferred or widened scope.

Negative acceptance cases include absent or unavailable Shared policy/source authority; authority lacking exact workspace scope; tenant, workspace, principal, project, revision, timeline, semantic-version, target, artifact, version, or digest mismatch; missing source-rights decision; stale or expired evidence; revocation between source read and output registration; and unknown or conflicting policy results. Each must yield zero source-byte reads when detected before consumption and zero rendered/output artifacts; a failed pre-registration revalidation must never register output. The existing persisted Media rights provider is not a conforming binding for this operation: `MediaSourceAuthorizationContracts.Request` and `Evidence` bind tenant, principal, artifact/version/digest, and processing effect, but have no workspace/project/revision/timeline fields; `MediaSourceRightsAdministration.RegisterRequest` likewise stores no workspace. No synthetic authority is admitted by this decision.

Source behavior is observed in `launcher/src/main/java/com/ghatana/media/launcher/MediaDevProjectRenderRuntime.java` and its DEV_ONLY route in `launcher/src/main/java/com/ghatana/media/launcher/MediaHttpHandler.java`; these references establish that render consumes bytes and registers output, not that the required authority exists. The missing authority shape is visible in `runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaSourceAuthorizationContracts.java#Request`, `#Evidence`, and `runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaSourceRightsAdministration.java#RegisterRequest`; these contracts do not bind workspace, project, revision, or timeline. The exact missing provider capability is recorded here so the render operation remains blocked until a real workspace-bound authority is admitted.
