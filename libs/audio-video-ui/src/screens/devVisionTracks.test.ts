import { describe, expect, it } from "vitest";
import {
  DevVisionHostError, VisionTracksParseError, boxesAt, describeVisionFailure, formatSeconds, parseVisionTracksDocument,
  type VisionTracksDocument,
} from "./devVisionTracks";
import { sampleDocument } from "./visionTracksFixture";

const clone = (): Record<string, any> => JSON.parse(JSON.stringify(sampleDocument()));

describe("parseVisionTracksDocument", () => {
  it("reads a complete document with exact PTS and boxes in source pixels", () => {
    const document = parseVisionTracksDocument(sampleDocument());
    expect(document.video).toMatchObject({ width: 640, height: 360, timeBase: { num: 1, den: 10240 } });
    expect(document.tracks.map((track) => track.trackId)).toEqual(["T0001", "T0002"]);
    expect(document.tracks[0]!.observations[1]).toMatchObject({ frameIndex: 3, pts: 3072, ptsMicros: 300000, box: { x: 47, y: 250 } });
  });

  it.each([
    ["wrong schema", (d: Record<string, any>) => { d.schema = "other"; }],
    ["wrong scope", (d: Record<string, any>) => { d.scope = "PRODUCTION"; }],
    ["box outside to the right", (d: Record<string, any>) => { d.tracks[0].observations[2].box.x = 500; }],
    ["box negative origin", (d: Record<string, any>) => { d.tracks[0].observations[0].box.y = -1; }],
    ["zero-size box", (d: Record<string, any>) => { d.tracks[0].observations[0].box.width = 0; }],
    ["non-finite box", (d: Record<string, any>) => { d.tracks[0].observations[0].box.height = null; }],
    ["observation PTS differs from its frame", (d: Record<string, any>) => { d.tracks[0].observations[1].pts = 3073; }],
    ["observation of an unsampled frame", (d: Record<string, any>) => { d.tracks[0].observations[1].frameIndex = 4; }],
    ["non-increasing frame PTS", (d: Record<string, any>) => { d.frames[1].pts = 0; }],
    ["duplicate track id", (d: Record<string, any>) => { d.tracks[1].trackId = "T0001"; }],
    ["track without observations", (d: Record<string, any>) => { d.tracks[1].observations = []; }],
    ["frame outside the video", (d: Record<string, any>) => { d.frames[2].frameIndex = 30; }],
    ["zero time base", (d: Record<string, any>) => { d.video.timeBase.den = 0; }],
    ["bad source digest", (d: Record<string, any>) => { d.source.sha256 = "ABC"; }],
    ["no frames", (d: Record<string, any>) => { d.frames = []; }],
  ])("refuses %s", (_name, mutate) => {
    const document = clone();
    mutate(document);
    expect(() => parseVisionTracksDocument(document)).toThrow(VisionTracksParseError);
  });

  it("refuses non-objects", () => {
    for (const value of [null, 1, "x", [], undefined]) expect(() => parseVisionTracksDocument(value)).toThrow(VisionTracksParseError);
  });
});

describe("boxesAt", () => {
  const document = (): VisionTracksDocument => parseVisionTracksDocument(sampleDocument());

  it("has nothing before the first sampled frame only when the playhead precedes it", () => {
    const shifted = clone();
    shifted.frames = shifted.frames.map((frame: any) => ({ ...frame, ptsMicros: frame.ptsMicros + 1000 }));
    expect(boxesAt(parseVisionTracksDocument(shifted), 500)).toMatchObject({ frame: null, sync: "before-first", boxes: [] });
  });

  it("selects the sampled frame whose PTS governs the playhead and marks exact versus held", () => {
    const d = document();
    const atStart = boxesAt(d, 0);
    expect(atStart.frame?.frameIndex).toBe(0);
    expect(atStart.sync).toBe("exact");
    expect(atStart.boxes.map(({ track }) => track.trackId)).toEqual(["T0001"]);
    const exact = boxesAt(d, 300_000);
    expect(exact.frame?.frameIndex).toBe(3);
    expect(exact.sync).toBe("exact");
    expect(exact.boxes.map(({ track }) => track.trackId)).toEqual(["T0001", "T0002"]);
    const held = boxesAt(d, 450_000);
    expect(held.frame?.frameIndex).toBe(3);
    expect(held.sync).toBe("held");
    expect(boxesAt(d, 299_999).frame?.frameIndex).toBe(0);
    expect(boxesAt(d, 10_000_000).frame?.frameIndex).toBe(6);
    expect(boxesAt(d, 600_000 + 40_000).sync).toBe("exact");
  });

  it("respects a custom tolerance", () => {
    expect(boxesAt(document(), 310_000, 5_000).sync).toBe("held");
    expect(boxesAt(document(), 310_000, 20_000).sync).toBe("exact");
  });
});

describe("helpers", () => {
  it("formats microseconds as seconds", () => {
    expect(formatSeconds(300000)).toBe("0.300 s");
    expect(formatSeconds(0)).toBe("0.000 s");
  });

  it("types host failures without claiming success", () => {
    expect(describeVisionFailure(new DevVisionHostError("VISION_OUTCOME_UNKNOWN", 503, "x")).tone).toBe("unknown");
    expect(describeVisionFailure(new DevVisionHostError("OUTCOME_UNKNOWN", 0, "x")).text).toContain("nothing was registered");
    expect(describeVisionFailure(new DevVisionHostError("RIGHTS_REVOKED", 403, "x")).tone).toBe("denied");
    expect(describeVisionFailure(new DevVisionHostError("SOURCE_VERSION_NOT_FOUND", 404, "x")).tone).toBe("refused");
    expect(describeVisionFailure(new DevVisionHostError("LOCAL_MODEL_NOT_ADMITTED", 503, "x")).tone).toBe("unavailable");
    expect(describeVisionFailure(new Error("boom")).code).toBe("INVALID_RESPONSE");
  });
});
