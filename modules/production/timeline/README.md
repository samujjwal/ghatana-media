# Project timeline engine

This module implements immutable editorial graph revisions behind the
`ProjectTimelineStore` authority port. The included in-memory store is a
process-local reference/test implementation; it is not durable storage, is not
wired into the launcher, and must not be used as a second production writer.
The eventual durable adapter must atomically commit the project head and its
immutable revision in one store transaction.

The local graph binds every clip to an exact artifact version and keeps source
presentation time separate from story time. Rational tick rates are reduced,
comparisons and additions use integer arithmetic, and clip end times that cannot
be represented exactly within the bounded rational contract are rejected.
Graph snapshots are immutable and
canonicalized by declared scene, track, and story-time order. Edits produce a
new revision with a parent pointer; the CAS head check prevents stale writes.
Diff ordering is stable, and `restore` creates a new successor revision from an
exact immutable historical graph for guarded undo/redo. The graph validates
scene/track/clip references but permits overlapping clips because transition
and overlap semantics are not fully bound to an accepted PDP-1 graph mapping.

Source-rights currentness is checked through `SourceEligibilityPort` at the
effect boundary for every exact source version. `REVOKED`, `UNKNOWN`, absent
authority, and authority failures block the effect with a typed result. The
predicate overload remains for local compatibility. This module does not
render, resolve artifact bytes, establish rights, or claim provider readiness. PDP-1
defines project and timeline identities and immutable project revisions, but
the exact project-revision-to-scene/clip/track graph field mapping remains
unresolved; the fields here are a conservative, explicitly local assumption.
The current reference authority applies owner-principal-only access within the
tenant; shared workspace membership and project-policy evaluation remain
unbound and must be supplied by the admitted host/policy boundary before a
durable runtime adapter can expose shared editing. `InMemoryProjectTimelineStore`
is only a process-local development/test authority. Hosts without an admitted
durable single-writer store can bind `NotAdmittedProjectTimelineStore`, which
returns the typed `PROJECT_TIMELINE_STORE / NOT_ADMITTED` outcome instead of
accepting edits that would disappear on restart. No durable adapter or launcher
binding currently exists.

`StoryboardPlanner` prepares deterministic authored-only scene/shot editions. Declared scene and shot
order is retained independently from exact rational story-time values, and every brief/shot source
reference is checked by current rights at preparation and again before save/review. Editions transition
through `LOCAL_DRAFT`, `PERSISTED_DRAFT`, and `REVIEWED` only when the corresponding append port returns
an exact owner receipt; a review receipt is separate and does not imply approval. The planner contains
no model generation or renderer readiness claim. Its ports are integration seams, not durable authority
implementations. Hosts without the admitted authority can bind
`NotAdmittedStoryboardAuthority`, which returns a typed zero-effect result for save or
review. No persistent storyboard adapter, reviewer authority, or renderer is currently
admitted.

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
any host exposes the draft operation.
