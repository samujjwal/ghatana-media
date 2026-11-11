# Source-free storyboard draft consumer

This isolated Java example accepts a user-authored brief and authored scene/shot
intervals, calls `StoryboardPlanner.prepare`, and prints deterministic ordered
JSON. It does not accept source references, call an AI/model/provider, persist a
project revision, review or approve a plan, or render media.

Run from the repository root:

```sh
./gradlew :services:media:examples:media-storyboard-draft:run \
  --args='example-brief.json'
```

The input is UTF-8 JSON, limited to 1 MiB. The sample file is runnable as-is.
The command/API requires caller-supplied tenant/principal and local plan scope
identifiers; they are validation metadata only and are not used to authenticate
or write to a project. Every scene and shot requires an ID, non-negative integer
order, non-blank authored intent, `storyStart`, `storyDuration`, and (for each
scene) at least one shot. Each time object is an exact rational `{ "ticks": n,
"rateNumerator": n, "rateDenominator": n }`, where rates are ticks per second.
The consumer assigns `Clock.STORY`; it performs no clock conversion or overlap
interpretation. Shot intervals must be contained within their scene.

Extra fields are rejected, including source-reference fields. Scene and shot
identities/orders must be unique (shot IDs are unique across the storyboard).
`StoryboardPlanner` applies its existing local safety bounds and exact rational
interval validation. Each scene and shot also reports a derived
`storyEndExclusive` endpoint, computed exactly from its start and duration, so
an author can inspect the represented interval without doing timebase math.
The endpoint is descriptive: scene order remains authored order, and this
consumer does not impose chronological ordering, continuity, or inter-scene
overlap rules whose owner semantics are not yet defined. The JSON output discloses `LOCAL_DRAFT_CANDIDATE`,
`USER_AUTHORED_SOURCE_FREE`, `renderable: false`, and
`persistence: NOT_PERFORMED`. Its project and revision IDs are scope labels only;
they do not identify a durable revision created or read by this example.

## Source boundary

PDP-0 `media.compose.scene-storyboard-assemble` defines the result as a local
composition candidate/draft, says source-free authored output identifies its
authored origin without fabricating source lineage, and does not assert a
committed change or render. The exact append action
`media.operation.action.save-storyboard-revision` remains a separate immutable
owner-receipt boundary; this consumer never invokes it. Canonical
`scenePlanRef`/`sceneRefs`/`timelineRef` mapping and reviewer authority remain
unresolved for the broader task, so the output stays an in-memory local draft.

Before adding persisted storyboards, the owner contract must answer whether
scene `order` is independent of absolute `Clock.STORY` intervals and whether
those intervals may overlap or leave gaps. It must also bind `scenePlanRef`,
`sceneRefs`, and `timelineRef` to canonical project/revision identities and
specify one admitted append authority that atomically compares both the
project-head revision and expected parent semantic version. The wire schema
requires all three refs but does not provide that graph mapping or an admitted
authority implementation; the planner's port remains fail-closed until then.

Focused checks:

```sh
./gradlew :services:media:examples:media-storyboard-draft:test
./gradlew :services:media:modules:production:timeline:test \
  --tests com.ghatana.media.production.timeline.StoryboardPlannerTest
```

These are consumer and planner unit checks only. They do not establish source
rights, persistence, review authority, renderer readiness, or runtime admission.
