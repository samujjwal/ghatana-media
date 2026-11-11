# Project timeline engine

## Purpose

This library owns deterministic editorial graph edits and immutable project
revision creation for Media. Its product rule is one project revision head for
all timelines: an initial revision is empty, and every timeline creation,
edit, or restore appends a successor project revision through the same
compare-and-set boundary.

This module implements immutable editorial graph revisions behind the
`ProjectTimelineStore` authority port. The included in-memory store is a
process-local reference/test implementation; it is not durable storage and
must not be used as a second production writer. The PostgreSQL adapter commits
the project head and immutable revision in one transaction. Its canonical V030
schema remains test-resource-only. A separate opt-in DEV_ONLY host lane uses a
loopback database and a caller-named `media_dev_*` schema with the isolated
`db/media-project-timeline-dev` migration location; this path is not discovered
by normal launcher migration or production-like composition.

The local graph binds every clip to an exact artifact version and keeps source
presentation time separate from story time. Rational tick rates are reduced,
comparisons and additions use integer arithmetic, and clip end times that cannot
be represented exactly within the bounded rational contract are rejected.
Project creation validates the PDP-1 required title before storage: nonblank,
with a maximum of 200 Unicode code points. Invalid titles are rejected before
the PostgreSQL store creates either a project or an idempotency receipt. This
input check does not establish production writer admission.
Graph snapshots are immutable and
canonicalized by declared scene, track, and story-time order. A project starts
with an empty revision and no timelines. Explicit timeline creation adds an
empty timeline snapshot to a successor `ProjectRevision`; each snapshot pairs
the stable `timelineId` with an opaque `semanticVersionId`. Timeline edits keep
the same `timelineId`, give the changed snapshot a new semantic version, and
append one project revision through the project-head CAS. Unchanged timeline
snapshots retain their version IDs. `restore` creates one successor project
revision containing the selected historical content; changed timeline content
receives new semantic version IDs. There is no separate writable timeline head.
The graph validates scene/track/clip references but permits overlapping clips
because transition and overlap semantics remain undefined.

Consumers with a `ProjectTimelineEngine` can call
`diff(actor, projectId, fromRevisionId, toRevisionId)` to read and compare two
immutable project revisions through the configured store. The returned
`RevisionDiff` includes both revision IDs, added and removed timeline IDs, and
sorted graph deltas for timelines present in both revisions, so a local
revision-history view can state exactly which snapshots it compares.
The engine also verifies each returned tenant, project, and revision identity
against the requested scope; an adapter mismatch fails with a stable generic
error. Reads use the store's tenant and owner checks; an unavailable revision returns
the stable `ProjectNotFoundException`, and an unauthorized principal receives
`ProjectAccessDeniedException`. This is a local read operation over the bound
store and does not make that store durable, canonical, or launcher-wired.
Revision diff reports timeline membership, graph structure, and exact values
only; it does not resolve artifact bytes, reauthorize source rights, or define
overlap policy.

Source-rights currentness is checked through `SourceEligibilityPort` at the
effect boundary for every exact source version. `REVOKED`, `UNKNOWN`, absent
authority, and authority failures block the effect with a typed result. A
throwing authority adapter maps to `SourceEligibility.UNKNOWN` without
retaining adapter details or a cause. The
predicate overload remains for local compatibility. This module does not
render, resolve artifact bytes, establish rights, or claim provider readiness.
The PDP-1 project/timeline mapping is now explicit: `ProjectRevision.timelines`
contains immutable timeline snapshots, and the project revision ID remains the
only authoritative write head. PDP-1 independent review remains open and this
local API has no canonical production admission. The PostgreSQL adapter stores
the complete typed snapshot list as a revision JSON value. Its canonical V030
test schema remains separate from the explicit DEV_ONLY migration. Neither path
establishes production migration or cutover authority.
The current reference authority applies owner-principal-only access within the
tenant; shared workspace membership and project-policy evaluation remain
unbound and must be supplied by the admitted host/policy boundary before a
durable runtime adapter can expose shared editing. `InMemoryProjectTimelineStore`
is only a process-local development/test authority. The PostgreSQL adapter is
an isolated development slice. Only its explicit `/dev/v1` host routes are
launcher-wired, and they require a verified DEV_ONLY identity, exact `dev`
profile, loopback PostgreSQL, and the separately enabled `media_dev_*` schema.
Shared membership, workspace policy, production admission, and human review
authority remain unbound.
Hosts without an admitted durable single-writer store can bind
`NotAdmittedProjectTimelineStore`, which
returns the typed `PROJECT_TIMELINE_STORE / NOT_ADMITTED` outcome instead of
accepting edits that would disappear on restart. No launcher binding exists.

`StoryboardPlanner` prepares deterministic authored-only scene/shot editions. Declared scene and shot
order is retained independently from exact rational story-time values, and every brief/shot source
reference is checked by current rights at preparation and again before save/review. Editions transition
through `LOCAL_DRAFT`, `PERSISTED_DRAFT`, and `REVIEWED` only when the corresponding append port returns
an exact owner receipt; a review receipt is separate and does not imply approval. The planner contains
no model generation or renderer readiness claim. Its ports are integration seams, not durable authority
implementations. Hosts without the admitted authority can bind
`NotAdmittedStoryboardAuthority`, which returns a typed zero-effect result for save or
review. Source-reference collections snapshot actual iterator traversal under a local 4,096-reference
ceiling; PDP-1 defines no per-list maximum, so this is an implementation resource bound rather than a
product limit. No persistent storyboard adapter, reviewer authority, or renderer is currently admitted.
The source-free example derives exact exclusive scene/shot endpoints for author inspection; it does not
infer chronological scene order, continuity, or overlap policy. Before persistence, owner input must
define whether authored order and story-time chronology are related and whether intervals may overlap
or leave gaps, plus canonical `scenePlanRef`/`sceneRefs`/`timelineRef` mapping and one authority that
atomically checks both project-head and parent semantic-version expectations.

## Local conditioned-scene and tracked-region candidates

`ReferenceGuidedScenePlanner` checks each prompt, reference, authored template,
and continuity source against current authority using its exact artifact
version, digest, purpose, tenant, and principal. Its deterministic output is an
authored-template candidate with source provenance; it is not a generated or
persisted media artifact. The model path returns typed `NO_ADMITTED_PROVIDER`
unless a host supplies an admitted provider, and rechecks every source before
dispatch.

`ReversibleRegionEditEngine` validates caller-supplied region evidence at
source-domain presentation timestamps and checks rights at preparation, apply,
and undo. It verifies normalized bounding-box transforms and only accepts
byte-identical masks when no transform is applied. It does not run tracking,
warp masks, edit pixels, or persist revisions itself. Its store port must
provide scoped compare-and-set, idempotency, and append-only exact undo before
any host exposes the draft operation. Aggregate source and edited mask evidence
is locally bounded to 64 MiB before rights inspection; PDP-1 leaves the final
product limit unspecified, so this is a development safety ceiling only.

## Consumers and non-goals

The engine is a deterministic Java library for a host that already owns a
verified `Actor`, a `ProjectTimelineStore`, and current source-rights authority
when an operation may use source material. UI consumers should call the host's
public client and display the exact project head returned by that host; the UI
must not maintain a second writable timeline graph.

`ProjectTimelineEngine` is constructed with a `ProjectTimelineStore`. The store
owns authorization on each read/write and must commit a new immutable revision
only if the supplied expected project head is still current. A host that
dispatches a source-dependent effect supplies a live `SourceEligibilityPort`
and calls `requireCurrentSources` immediately before that effect, including
after retries. Store and authority ports are the extension boundary; adding a
second head or a UI-owned persistence adapter would break the model.

This module edits immutable project and timeline metadata. It does not read
artifact bytes, decode or render media, define clip overlap or transition
semantics, establish Shared workspace membership, or provide a production
identity or persistence authority. `InMemoryProjectTimelineStore` is for
tests/development only. `NotAdmittedProjectTimelineStore` is the production
fail-closed option until an owner-admitted durable writer is bound.

## Revision lifecycle example

Project creation follows the PDP-1 rule that the initial revision has no
timelines. A user creates a timeline explicitly, which appends an empty
snapshot to a successor revision. Edits, restores, and undo/redo history all
advance the same project head through compare-and-set:

```java
import static com.ghatana.media.production.timeline.ProjectTimelineEngine.*;
import static com.ghatana.media.runtime.MediaProjectTimelineContracts.*;
import java.util.List;

// actor is verified by the host; engine uses that host's selected store.
var created = engine.createProject(actor, "workspace-1", "Draft", "create-1");
var initial = created.initialRevision();
assert initial.timelines().isEmpty();

var withTimeline = engine.createTimeline(actor, created.project().projectId(),
        initial.revisionId(), "timeline-1");
var edited = engine.edit(actor, created.project().projectId(), "timeline-1",
        withTimeline.revisionId(), List.of(
                new AddScene(new Scene("scene-1", 0)),
                new AddTrack(new Track("track-1", "scene-1", TrackKind.VIDEO, 0))));
var changes = engine.diff(actor, created.project().projectId(),
        withTimeline.revisionId(), edited.revisionId());

// Restore appends another project revision; prior revisions stay immutable.
var restored = engine.restore(actor, created.project().projectId(),
        edited.revisionId(), withTimeline.revisionId());
```

Production callers must supply owner-issued identifiers and use the current
head read immediately before a mutation. A `RevisionConflictException` means
the observed head is stale; read the current head and reconcile the user's
intent before submitting a new edit. Never retry a stale edit by replacing the
expected revision automatically.

## Configuration, storage, and compatibility

This module has no independent database, network, or model configuration. The
host selects the store and ID supplier when it creates `ProjectTimelineEngine`.
The explicit DEV_ONLY PostgreSQL path uses a separate `media_dev_*` schema and
migration directory; it is enabled only through the signed local-development
profile, loopback database, and opt-in launcher route. It is not discovered by
the normal launcher migration path.

The canonical-looking V030 SQL under the provider's test resources is test-only
and is not production migration or writer admission. Do not promote it or the
DEV_ONLY V001 migration into a production deployment without the independent
PDP-1 contract review, owner-approved schema lifecycle, Shared membership and
policy boundary, and production writer admission.

## Capacity and lifecycle limits

The engine bounds one edit command to 10,000 operations. That is an internal
input-safety ceiling, not an owner-approved product maximum. The current graph
and immutable revision history have no aggregate per-project cardinality or
storage-retention budget. The launcher request-body limit bounds an individual
request only; it does not bound accumulated project history. The only wired
durable path is the isolated loopback DEV_ONLY profile, so this does not qualify
a production workload. Before any production writer is admitted, the storage
and product owners must define revision/graph budgets and retention behavior,
then verify exact-bound acceptance, over-bound no-commit behavior, restart,
concurrent CAS, and measured storage/CPU costs at the selected workload.

## Verification and evidence

Run the focused module suite when engine or runtime-contract behavior changes:

```bash
./gradlew :services:media:modules:production:timeline:test
./gradlew -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE -Pghatana.media.compositeScope=FULL :services:media:modules:production:timeline:test --tests com.ghatana.media.production.timeline.ProjectTimelineRevisionModelTest
```

For durable-store changes, also run the PostgreSQL store and DEV_ONLY factory
selectors, then the launcher HTTP selector. The browser restart selector uses
the DEV_SOURCE_COMPOSITE profile and requires PostgreSQL, LocalStack, the signed
DEV_ONLY issuer, and the pinned browser toolchain:

```bash
./gradlew -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE -Pghatana.media.compositeScope=FULL :services:media:providers:aws-postgresql:test --tests '*PostgresqlProjectTimelineStoreTest' --tests '*PostgresqlDevProjectTimelineStoreFactoryTest'
./gradlew -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE -Pghatana.media.compositeScope=FULL :services:media:launcher:test --tests '*MediaDevProjectTimelineHttpTest'
./gradlew -Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE -Pghatana.media.compositeScope=FULL :services:media:integration-tests:test --tests 'com.ghatana.media.integration.MediaDevProjectTimelineRestartIT.realExplorerBrowserCreatesReplaysAndReopensExactTimelineAcrossLauncherRestart'
```

These are engineering checks for local code and the isolated DEV_ONLY path.
They do not produce PDP acceptance, independent review, production admission,
release qualification, or a source-rights receipt. The source task and its
current evidence are tracked in
[`remaining-work.json`](../../../docs/development/remaining-work.json) under
`media.dev.project-timeline-engine`.

## Troubleshooting

- `RevisionConflictException`: the project head changed. Read the current
  revision and reconcile the requested edit before retrying.
- `ProjectAccessDeniedException` or `ProjectNotFoundException`: treat the
  project as unavailable to this actor; do not disclose cross-tenant details.
- `IdempotencyConflictException`: the create request ID was reused with a
  different workspace or title; use a new request ID for the new intent.
- `SourceEligibilityException`: `REVOKED`, `UNKNOWN`, missing authority, or an
  authority failure blocks source-dependent effects. Recheck current authority
  before any new dispatch; never treat the local graph as rights evidence.
- `PROJECT_TIMELINE_STORE / NOT_ADMITTED`: the host has no admitted durable
  writer. Do not substitute the in-memory reference store for persistence.
