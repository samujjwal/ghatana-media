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
