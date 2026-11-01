import { describe, expect, it } from "vitest";
import { hasAdmissibleCaptionTimingRange, transcriptActionContext } from "./TranscriptCaptionScreen";

describe("transcript action context", () => {
  it("keeps host authorization subjects and binds exact transcript and caption versions", () => {
    const context = transcriptActionContext({
      id: "media.action.correct-caption",
      label: "Correct caption",
      enabled: true,
      subjectRefs: ["tenant:tenant-a", "source-version:source-v7"],
    }, ["source-version:source-v7", "transcript-version:transcript-v3", "caption-draft:draft-v2"]);

    expect(context.subjectRefs).toEqual([
      "tenant:tenant-a",
      "source-version:source-v7",
      "transcript-version:transcript-v3",
      "caption-draft:draft-v2",
    ]);
  });

  it("drops absent and blank version references without inventing an owner scope", () => {
    expect(transcriptActionContext(undefined, [undefined, "", "  ", "selected-version-v4"])).toEqual({
      subjectRefs: ["selected-version-v4"],
    });
  });
});

describe("caption source-clock timing range", () => {
  const qualifiedClock = {
    clockId: "source-clock-v7",
    ticksPerSecond: 48_000,
    durationTicks: 480_000,
  };

  it("admits only safe half-open ranges inside the exact source duration", () => {
    expect(hasAdmissibleCaptionTimingRange(qualifiedClock, 0, 1)).toBe(true);
    expect(hasAdmissibleCaptionTimingRange(qualifiedClock, 100, 200)).toBe(true);
    expect(hasAdmissibleCaptionTimingRange(qualifiedClock, 200, 200)).toBe(false);
    expect(hasAdmissibleCaptionTimingRange(qualifiedClock, 201, 200)).toBe(false);
    expect(hasAdmissibleCaptionTimingRange(qualifiedClock, 0, 480_001)).toBe(false);
    expect(hasAdmissibleCaptionTimingRange(qualifiedClock, Number.MAX_SAFE_INTEGER + 1, 2)).toBe(false);
  });

  it("fails closed when the source clock tuple is incomplete or invalid", () => {
    expect(hasAdmissibleCaptionTimingRange({ ...qualifiedClock, clockId: " " }, 0, 1)).toBe(false);
    expect(hasAdmissibleCaptionTimingRange({ ...qualifiedClock, ticksPerSecond: 0 }, 0, 1)).toBe(false);
    expect(hasAdmissibleCaptionTimingRange({ ...qualifiedClock, durationTicks: undefined }, 0, 1)).toBe(false);
  });
});
