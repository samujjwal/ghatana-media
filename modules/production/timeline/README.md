# Project timeline engine

This module implements immutable editorial graph revisions behind the
`ProjectTimelineStore` authority port. The included in-memory store is a
process-local reference/test implementation; it is not durable storage, is not
wired into the launcher, and must not be used as a second production writer.
The eventual durable adapter must atomically commit the project head and its
immutable revision in one store transaction.

The local graph binds every clip to an exact artifact version and keeps source
presentation time separate from story time. Rational tick rates are reduced
and comparisons use integer arithmetic. The graph validates scene/track/clip
references but permits overlapping clips because transition and overlap
semantics are not fully bound to an accepted PDP-1 graph mapping.

Source-rights currentness is checked through a caller-supplied current
eligibility predicate at the effect boundary. This module does not render,
resolve artifact bytes, establish rights, or claim provider readiness. PDP-1
defines project and timeline identities and immutable project revisions, but
the exact project-revision-to-scene/clip/track graph field mapping remains
unresolved; the fields here are a conservative, explicitly local assumption.
The current reference authority applies owner-principal-only access within the
tenant; shared workspace membership and project-policy evaluation remain
unbound and must be supplied by the admitted host/policy boundary before a
durable runtime adapter can expose shared editing.

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
