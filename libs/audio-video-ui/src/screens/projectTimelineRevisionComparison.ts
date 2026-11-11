import type { DevProjectRevision, DevTimelineClip } from "@audio-video/client/dev-project-timeline";

export type TimelineEntityKind = "scene" | "track" | "clip";
export type TimelineEntityChange = {
  readonly timelineId: string;
  readonly kind: TimelineEntityKind;
  readonly entityId: string;
  readonly change: "added" | "removed" | "changed";
};
export type ProjectRevisionComparison = {
  readonly fromRevisionId: string;
  readonly toRevisionId: string;
  readonly addedTimelineIds: readonly string[];
  readonly removedTimelineIds: readonly string[];
  readonly changes: readonly TimelineEntityChange[];
};

const sameTime = (left: DevTimelineClip["sourceIn"], right: DevTimelineClip["sourceIn"]): boolean =>
  left.clock === right.clock
  && BigInt(left.ticks) * BigInt(left.rateDenominator) * BigInt(right.rateNumerator)
    === BigInt(right.ticks) * BigInt(right.rateDenominator) * BigInt(left.rateNumerator);

const sameClip = (left: DevTimelineClip, right: DevTimelineClip): boolean =>
  left.clipId === right.clipId && left.sceneId === right.sceneId && left.trackId === right.trackId
  && left.source.artifactId === right.source.artifactId
  && left.source.artifactVersionId === right.source.artifactVersionId
  && sameTime(left.sourceIn, right.sourceIn) && sameTime(left.sourceOut, right.sourceOut)
  && sameTime(left.storyStart, right.storyStart) && sameTime(left.storyDuration, right.storyDuration);

const stringField = (value: Readonly<Record<string, unknown>>, key: string): string => {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`Timeline ${key} identity is malformed.`);
  return field;
};

function uniqueById<T>(values: readonly T[], idOf: (value: T) => string, label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const id = idOf(value);
    if (result.has(id)) throw new Error(`Timeline comparison has duplicate ${label} identity ${id}.`);
    result.set(id, value);
  }
  return result;
}

function changesById<T>(
  timelineId: string,
  kind: TimelineEntityKind,
  before: readonly T[],
  after: readonly T[],
  idOf: (item: T) => string,
  equal: (left: T, right: T) => boolean,
): TimelineEntityChange[] {
  const left = uniqueById(before, idOf, kind);
  const right = uniqueById(after, idOf, kind);
  const ids = [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => a.localeCompare(b));
  return ids.flatMap((entityId) => {
    const oldValue = left.get(entityId);
    const newValue = right.get(entityId);
    const change = oldValue === undefined ? "added" : newValue === undefined ? "removed"
      : equal(oldValue, newValue) ? null : "changed";
    return change ? [{ timelineId, kind, entityId, change }] : [];
  });
}

/** Compare two exact immutable project snapshots. This reports graph structure only. */
export function compareProjectRevisions(from: DevProjectRevision, to: DevProjectRevision): ProjectRevisionComparison {
  if (from.tenantId !== to.tenantId || from.projectId !== to.projectId) {
    throw new Error("Cannot compare revisions from different tenant or project identities.");
  }
  const before = uniqueById(from.timelines.map((timeline) => timeline.graph), (graph) => graph.timelineId, "timeline");
  const after = uniqueById(to.timelines.map((timeline) => timeline.graph), (graph) => graph.timelineId, "timeline");
  const timelineIds = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a.localeCompare(b));
  const changes = timelineIds.flatMap((timelineId) => {
    const left = before.get(timelineId);
    const right = after.get(timelineId);
    return [
      ...changesById(timelineId, "scene", left?.scenes ?? [], right?.scenes ?? [], (scene) => stringField(scene, "sceneId"),
        (a, b) => a.sceneId === b.sceneId && a.order === b.order),
      ...changesById(timelineId, "track", left?.tracks ?? [], right?.tracks ?? [], (track) => stringField(track, "trackId"),
        (a, b) => a.trackId === b.trackId && a.sceneId === b.sceneId && a.kind === b.kind && a.order === b.order),
      ...changesById(timelineId, "clip", left?.clips ?? [], right?.clips ?? [], (clip) => clip.clipId, sameClip),
    ];
  }).sort((a, b) => a.timelineId.localeCompare(b.timelineId)
    || a.kind.localeCompare(b.kind) || a.entityId.localeCompare(b.entityId));
  return {
    fromRevisionId: from.revisionId,
    toRevisionId: to.revisionId,
    addedTimelineIds: timelineIds.filter((id) => !before.has(id)),
    removedTimelineIds: timelineIds.filter((id) => !after.has(id)),
    changes,
  };
}
