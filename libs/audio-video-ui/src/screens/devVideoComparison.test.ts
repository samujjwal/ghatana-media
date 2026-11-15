import { describe, expect, it } from "vitest";
import {
  DevVideoHostError, VideoComparisonParseError, describeVideoFailure, formatSigned, frameAt, metricSeries,
  parseVideoComparisonDocument,
} from "./devVideoComparison";
import { sampleComparison } from "./videoComparisonFixture";

const mutate = (change: (document: Record<string, any>) => void, options?: Parameters<typeof sampleComparison>[0]): unknown => {
  const document = sampleComparison(options) as Record<string, any>;
  change(document);
  return document;
};

describe("parseVideoComparisonDocument", () => {
  it("reads a complete reference comparison with per-frame numbers", () => {
    const document = parseVideoComparisonDocument(sampleComparison());
    expect(document.reference?.artifactId).toBe("ref-1");
    expect(document.subjects.map((s) => s.label)).toEqual(["degraded", "enhanced"]);
    expect(document.subjects[1]!.againstReference!.meanPsnrY).toBeCloseTo(26.67, 1);
    expect(document.comparisons[0]).toMatchObject({ verdict: "IMPROVED", framesPsnrRegressed: 1 });
    expect(metricSeries(document.subjects[1]!, "psnrY")).toHaveLength(6);
  });

  it("reads a no-reference comparison without inventing PSNR or SSIM", () => {
    const document = parseVideoComparisonDocument(sampleComparison({ reference: false }));
    expect(document.reference).toBeNull();
    expect(document.subjects[0]!.againstReference).toBeNull();
    expect(metricSeries(document.subjects[0]!, "psnrY")).toEqual([]);
    expect(document.comparisons[0]!.verdict).toBe("NO_REFERENCE");
    expect(document.comparisons[0]!.meanPsnrYDeltaDb).toBeNull();
  });

  it.each<[string, (d: Record<string, any>) => void]>([
    ["wrong schema", (d) => { d.schema = "x"; }],
    ["not DEV_ONLY", (d) => { d.scope = "PRODUCTION"; }],
    ["bad digest", (d) => { d.subjects[0].source.sha256 = "ABC"; }],
    ["duplicate label", (d) => { d.subjects[1].label = "degraded"; }],
    ["non-finite PSNR", (d) => { d.subjects[0].frames[2].psnrY = null; }],
    ["PSNR out of bounds", (d) => { d.subjects[0].frames[2].psnrY = 1000; }],
    ["SSIM out of bounds", (d) => { d.subjects[0].frames[2].ssimY = 3; }],
    ["frame times not increasing", (d) => { d.subjects[0].frames[3].ptsMicros = 0; }],
    ["alignment flag without numbers", (d) => { delete d.subjects[0].frames[1].ssimY; }],
    ["no frames", (d) => { d.subjects[0].frames = []; }],
    ["unknown verdict", (d) => { d.comparisons[0].verdict = "GREAT"; }],
    ["comparison names an unknown subject", (d) => { d.comparisons[0].subject = "ghost"; }],
    ["too many subjects", (d) => { d.subjects.push(d.subjects[0], d.subjects[0]); }],
    ["reference numbers without a reference", (d) => { delete d.reference; }],
  ])("refuses %s", (_name, change) => {
    expect(() => parseVideoComparisonDocument(mutate(change))).toThrow(VideoComparisonParseError);
  });
});

describe("helpers", () => {
  it("finds the frame governing a playhead time", () => {
    const subject = parseVideoComparisonDocument(sampleComparison()).subjects[0]!;
    expect(frameAt(subject, -5).frameIndex).toBe(0);
    expect(frameAt(subject, 79_999).frameIndex).toBe(1);
    expect(frameAt(subject, 80_000).frameIndex).toBe(2);
    expect(frameAt(subject, 9_000_000).frameIndex).toBe(5);
  });

  it("signs deltas explicitly and never hides a negative", () => {
    expect(formatSigned(2.5, 2, " dB")).toBe("+2.50 dB");
    expect(formatSigned(-0.31, 2, " dB")).toBe("−0.31 dB");
    expect(formatSigned(null, 2, "")).toBe("n/a");
  });

  it("classifies host failures", () => {
    expect(describeVideoFailure(new DevVideoHostError("VIDEO_OUTCOME_UNKNOWN", 503, "x")).tone).toBe("unknown");
    expect(describeVideoFailure(new DevVideoHostError("OUTCOME_UNKNOWN", 0, "x")).tone).toBe("unknown");
    expect(describeVideoFailure(new DevVideoHostError("RIGHTS_REVOKED", 403, "x")).tone).toBe("denied");
    expect(describeVideoFailure(new DevVideoHostError("SOURCE_VIDEO_CORRUPT", 422, "bad")).text).toContain("SOURCE_VIDEO_CORRUPT");
    expect(describeVideoFailure(new DevVideoHostError("SOURCE_VERSION_NOT_FOUND", 404, "x")).tone).toBe("refused");
    expect(describeVideoFailure(new DevVideoHostError("RIGHTS_AUTHORITY_UNAVAILABLE", 503, "x")).tone).toBe("unavailable");
  });
});
