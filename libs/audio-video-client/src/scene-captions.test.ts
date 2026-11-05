import { describe, expect, it } from "vitest";
import {
  admitNarrationSource,
  compileSceneTtml,
  compileSceneVtt,
  cuesAtOffset,
  SceneCaptionError,
  truncateCuesAt,
  validateCaptionCues,
  type CaptionCue,
  type SourceCaptionClock,
} from "./scene-captions";

const clock: SourceCaptionClock = {
  frameClockRef: "clock/ntsc-30",
  ticksPerSecond: 30_000,
  sourceDurationTicks: 300_000, // 10s at 30kHz
};

const cues: readonly CaptionCue[] = [
  { cueId: "c1", text: "hello scene", startTick: 1_500, endTick: 60_000 },
  { cueId: "c2", text: "second line", startTick: 60_000, endTick: 120_000 },
];

describe("compileSceneVtt", () => {
  it("emits WebVTT with exact tick-derived timestamps", () => {
    const vtt = compileSceneVtt(cues, clock);
    expect(vtt.startsWith("WEBVTT\n")).toBe(true);
    expect(vtt).toContain("00:00:00.050 --> 00:00:02.000");
    expect(vtt).toContain("00:00:02.000 --> 00:00:04.000");
    expect(vtt).toContain("hello scene");
  });

  it("redacts private content and host patterns before emitting", () => {
    const secretCue = [{ cueId: "s", text: "token=supersecretvalue here", startTick: 0, endTick: 30_000 }];
    const vtt = compileSceneVtt(secretCue, clock, { redactPatterns: [/hunter2/g] });
    expect(vtt).not.toContain("supersecretvalue");
    expect(vtt).toContain("‹REDACTED›");
  });
});

describe("compileSceneTtml", () => {
  it("emits TTML with frame-aligned begin/end and language", () => {
    const ttml = compileSceneTtml(cues, clock, { languageTag: "en" });
    expect(ttml).toContain('xml:lang="en"');
    expect(ttml).toContain('begin="00:00:00.050"');
    expect(ttml).toContain('end="00:00:02.000"');
  });
});

describe("validateCaptionCues", () => {
  it("rejects cues outside the declared source duration", () => {
    expect(() => validateCaptionCues(
      [{ cueId: "x", text: "t", startTick: 0, endTick: 400_000 }], clock,
    )).toThrow(SceneCaptionError);
  });

  it("rejects unordered, empty-range and non-integer cues", () => {
    expect(() => validateCaptionCues(
      [{ cueId: "a", text: "t", startTick: 60_000, endTick: 90_000 },
       { cueId: "b", text: "t", startTick: 10_000, endTick: 20_000 }], clock)).toThrow(SceneCaptionError);
    expect(() => validateCaptionCues(
      [{ cueId: "a", text: "t", startTick: 50_000, endTick: 50_000 }], clock)).toThrow(SceneCaptionError);
    expect(() => validateCaptionCues(
      [{ cueId: "a", text: "t", startTick: 0.5, endTick: 30_000 } as never], clock)).toThrow(SceneCaptionError);
  });

  it("rejects an invalid clock declaration", () => {
    expect(() => validateCaptionCues(cues,
      { ...clock, ticksPerSecond: 0 })).toThrow(SceneCaptionError);
    expect(() => validateCaptionCues(cues,
      { ...clock, frameClockRef: "" })).toThrow(SceneCaptionError);
  });
});

describe("admitNarrationSource", () => {
  it("admits APPROVED_TTS and USER_PROVIDED only", () => {
    expect(() => admitNarrationSource({ tag: "APPROVED_TTS", voiceRef: "voice/en-approved" })).not.toThrow();
    expect(() => admitNarrationSource({ tag: "USER_PROVIDED", trackRef: "narration/u1" })).not.toThrow();
  });

  it("refuses voice substitution and unknown sources — no unsupported voice substitution", () => {
    for (const tag of ["CLONED_VOICE", "SYNTHESIZED_LOOKALIKE", "ANY_ONLINE_VOICE", ""]) {
      expect(() => admitNarrationSource({ tag })).toThrow(SceneCaptionError);
    }
  });
});

describe("seek and cancel", () => {
  it("cuesAtOffset returns cues covering an exact source tick", () => {
    expect(cuesAtOffset(cues, 30_000).map((c) => c.cueId)).toEqual(["c1"]);
    expect(cuesAtOffset(cues, 60_000).map((c) => c.cueId)).toEqual(["c2"]);
    expect(cuesAtOffset(cues, 299_999)).toEqual([]);
  });

  it("truncateCuesAt cancels at an exact tick, clipping the in-flight cue", () => {
    const kept = truncateCuesAt(cues, 90_000);
    expect(kept).toHaveLength(2);
    expect(kept[1]!.endTick).toBe(90_000);
    expect(truncateCuesAt(cues, 30_000)).toHaveLength(1);
    expect(truncateCuesAt(cues, 0)).toHaveLength(0);
  });
});
