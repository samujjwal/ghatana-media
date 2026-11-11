import { describe, expect, it } from "vitest";
import type { DevProjectRevision } from "@audio-video/client/dev-project-timeline";
import { compareProjectRevisions } from "./projectTimelineRevisionComparison";

const empty = (revisionId: string, timelines: DevProjectRevision["timelines"] = []): DevProjectRevision => ({
  tenantId: "tenant-a", projectId: "project-a", revisionId, parentRevisionId: null, timelines,
});

describe("compareProjectRevisions", () => {
  it("reports stable additions, removals, and changes without depending on graph array order", () => {
    const before = empty("rev-1", [
      { semanticVersionId: "v1", graph: { timelineId: "cut", scenes: [{ sceneId: "scene", order: 0 }], tracks: [], clips: [] } },
      { semanticVersionId: "v2", graph: { timelineId: "removed-cut", scenes: [], tracks: [], clips: [] } },
    ]);
    const after = empty("rev-2", [
      { semanticVersionId: "v3", graph: { timelineId: "added-cut", scenes: [], tracks: [], clips: [] } },
      { semanticVersionId: "v4", graph: { timelineId: "cut", scenes: [{ sceneId: "scene", order: 2 }, { sceneId: "new-scene", order: 1 }], tracks: [], clips: [] } },
    ]);

    expect(compareProjectRevisions(before, after)).toEqual({
      fromRevisionId: "rev-1",
      toRevisionId: "rev-2",
      addedTimelineIds: ["added-cut"],
      removedTimelineIds: ["removed-cut"],
      changes: [
        { timelineId: "cut", kind: "scene", entityId: "new-scene", change: "added" },
        { timelineId: "cut", kind: "scene", entityId: "scene", change: "changed" },
      ],
    });
  });

  it("reports nested entity additions and removals for populated timelines", () => {
    const clip = {
      clipId: "clip", sceneId: "scene", trackId: "track",
      source: { artifactId: "artifact", artifactVersionId: "sha256:version" },
      sourceIn: { ticks: "0", rateNumerator: "1", rateDenominator: "1", clock: "SOURCE_PRESENTATION" as const },
      sourceOut: { ticks: "1", rateNumerator: "1", rateDenominator: "1", clock: "SOURCE_PRESENTATION" as const },
      storyStart: { ticks: "0", rateNumerator: "1", rateDenominator: "1", clock: "STORY" as const },
      storyDuration: { ticks: "1", rateNumerator: "1", rateDenominator: "1", clock: "STORY" as const },
    };
    const populatedGraph = (timelineId: string) => ({
      timelineId,
      scenes: [{ sceneId: "scene", order: 0 }],
      tracks: [{ trackId: "track", sceneId: "scene", kind: "VIDEO", order: 0 }],
      clips: [clip],
    });
    const result = compareProjectRevisions(
      empty("rev-1", [{ semanticVersionId: "old", graph: populatedGraph("removed-populated") }]),
      empty("rev-2", [{ semanticVersionId: "new", graph: populatedGraph("added-populated") }]),
    );

    expect(result.addedTimelineIds).toEqual(["added-populated"]);
    expect(result.removedTimelineIds).toEqual(["removed-populated"]);
    expect(result.changes).toEqual([
      { timelineId: "added-populated", kind: "clip", entityId: "clip", change: "added" },
      { timelineId: "added-populated", kind: "scene", entityId: "scene", change: "added" },
      { timelineId: "added-populated", kind: "track", entityId: "track", change: "added" },
      { timelineId: "removed-populated", kind: "clip", entityId: "clip", change: "removed" },
      { timelineId: "removed-populated", kind: "scene", entityId: "scene", change: "removed" },
      { timelineId: "removed-populated", kind: "track", entityId: "track", change: "removed" },
    ]);
  });

  it("compares exact large rational clip coordinates and does not flag equivalent rate encodings", () => {
    const clip = {
      clipId: "clip", sceneId: "scene", trackId: "track",
      source: { artifactId: "artifact", artifactVersionId: "sha256:version" },
      sourceIn: { ticks: "9007199254740993", rateNumerator: "48000", rateDenominator: "1", clock: "SOURCE_PRESENTATION" as const },
      sourceOut: { ticks: "9007199254741093", rateNumerator: "48000", rateDenominator: "1", clock: "SOURCE_PRESENTATION" as const },
      storyStart: { ticks: "0", rateNumerator: "24000", rateDenominator: "1", clock: "STORY" as const },
      storyDuration: { ticks: "50", rateNumerator: "24000", rateDenominator: "1", clock: "STORY" as const },
    };
    const equivalent = {
      ...clip,
      sourceIn: { ...clip.sourceIn, ticks: "18014398509481986", rateNumerator: "96000" },
      sourceOut: { ...clip.sourceOut, ticks: "18014398509482186", rateNumerator: "96000" },
    };
    const before = empty("rev-1", [{ semanticVersionId: "v1", graph: {
      timelineId: "cut", scenes: [{ sceneId: "scene", order: 0 }], tracks: [{ trackId: "track", sceneId: "scene", kind: "VIDEO", order: 0 }], clips: [clip],
    } }]);
    const after = empty("rev-2", [{ semanticVersionId: "v2", graph: {
      timelineId: "cut", scenes: [{ sceneId: "scene", order: 0 }], tracks: [{ trackId: "track", sceneId: "scene", kind: "VIDEO", order: 0 }], clips: [equivalent],
    } }]);

    expect(compareProjectRevisions(before, after).changes).toEqual([]);
    const changed = empty("rev-3", [{ semanticVersionId: "v3", graph: {
      timelineId: "cut", scenes: [{ sceneId: "scene", order: 0 }], tracks: [{ trackId: "track", sceneId: "scene", kind: "VIDEO", order: 0 }],
      clips: [{ ...equivalent, source: { ...equivalent.source, artifactVersionId: "sha256:other" } }],
    } }]);
    expect(compareProjectRevisions(before, changed).changes).toEqual([
      { timelineId: "cut", kind: "clip", entityId: "clip", change: "changed" },
    ]);
  });

  it("rejects revisions from another project or tenant", () => {
    expect(() => compareProjectRevisions(empty("rev-1"), { ...empty("rev-2"), tenantId: "tenant-b" }))
      .toThrow(/different tenant or project identities/);
    expect(() => compareProjectRevisions(empty("rev-1"), { ...empty("rev-2"), projectId: "project-b" }))
      .toThrow(/different tenant or project identities/);
  });

  it("rejects duplicate owner identities instead of silently dropping comparison rows", () => {
    const malformed = empty("rev-1", [{ semanticVersionId: "v1", graph: {
      timelineId: "cut", scenes: [{ sceneId: "same", order: 0 }, { sceneId: "same", order: 1 }], tracks: [], clips: [],
    } }]);
    expect(() => compareProjectRevisions(malformed, empty("rev-2", malformed.timelines)))
      .toThrow(/duplicate scene identity same/);
  });
});
