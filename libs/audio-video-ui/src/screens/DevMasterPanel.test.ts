// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevMasterPanel } from "./DevMasterPanel";
import {
  DevMasterHostError, blankStem, describeMasterFailure, parseMasterStatus, parseMasterView, parseStemView, toMasterRequest, toStemRequestSpec,
  type DevMasterHostResponse, type DevMasterPort,
} from "./devMaster";

afterEach(cleanup);

const hex = (c: string): string => c.repeat(64);
const statusBody = (over: { masterReady?: boolean } = {}): unknown => ({
  scope: "DEV_ONLY", stemReady: true, masterReady: over.masterReady ?? true,
  limits: { sampleRateHz: 48000, minStemMs: 50, maxStemMs: 30000, maxPlacements: 32, maxMasterFrames: 2880000 },
  generators: { kinds: ["TONE", "CHORD", "DRUM", "FOLEY"], drums: ["KICK", "SNARE", "HAT"], foley: ["FOOTSTEP", "WHOOSH", "IMPACT"] },
  target: { integratedLufs: { min: -30, max: -9, default: -16 }, truePeakDbtp: { min: -6, max: -0.1, default: -1 } },
});
const artifact = (id: string, c: string, type: string): Record<string, unknown> => ({ artifactId: id, artifactVersionId: `sha256:${hex(c)}`,
  contentType: type, sizeBytes: 5, sha256: hex(c) });
const stemBody = (): unknown => ({
  schema: "media.dev.stem.v1", scope: "DEV_ONLY", stemId: "stem-1", replayed: false, artifact: artifact("stem-1", "a", "audio/wav"),
  lineage: { generatorSpec: { kind: "TONE", durationMs: 1000, channels: 1 }, generatorSpecSha256: hex("9"), measurement: { samplePeakDbfs: -6.0 } },
});
const masterBody = (replayed = false): unknown => ({
  schema: "media.dev.master.v1", scope: "DEV_ONLY", masterId: "report-1", replayed,
  wav: artifact("wav-1", "b", "audio/wav"), flac: artifact("flac-1", "c", "audio/flac"), reportArtifact: artifact("report-1", "d", "application/json"),
  report: {
    format: { frames: 48000, durationSeconds: 1.0 }, target: { integratedLufs: -16, truePeakDbtp: -1 },
    measurement: { integratedLufs: -16.01, truePeakDbtp: -2.3, samplePeakDbfs: -2.4, clippedSamples: 0, preLimiterGainDb: 7.5,
      limiter: { maxGainReductionDb: 0, limitedFrames: 0 }, mix: { integratedLufs: -23.5 }, targetMet: true },
    rightsDecision: { uploadedStems: 0, originalProceduralStems: 1 },
    outputs: { flac: { verification: "decoded by FFmpeg and compared sample for sample with the WAV: identical" } },
    stems: [{ index: 0, artifactId: "stem-1", origin: "ORIGINAL_PROCEDURAL_SYNTHESIS", channels: 1, frames: 48000, gainDb: 0, pan: 0, startFrame: 4800,
      fadeInFrames: 0, fadeOutFrames: 0 }],
  },
});
const ok = (status: number, body: unknown): Promise<DevMasterHostResponse> => Promise.resolve({ status, body });
type FakePort = { [K in keyof DevMasterPort]-?: ReturnType<typeof vi.fn> };
function fakePort(over: Partial<DevMasterPort> = {}, status: unknown = statusBody()): FakePort {
  return { getStatus: vi.fn(() => ok(200, status)), generateStem: vi.fn(() => ok(201, stemBody())), master: vi.fn(() => ok(201, masterBody())),
    readArtifactContent: undefined, ...over } as unknown as FakePort;
}
const asPort = (port: FakePort): DevMasterPort => port as unknown as DevMasterPort;
const ids = (): (() => string) => { let n = 0; return () => `master-req-${++n}`; };
async function mounted(port: FakePort) {
  render(React.createElement(DevMasterPanel, { masters: asPort(port), newRequestId: ids() }));
  await waitFor(() => expect(document.querySelector("[data-status-line]")!.textContent).toContain("builds stems"));
}

describe("master authoring model", () => {
  it("builds the host stem spec and reports a non-number with its JSON path", () => {
    expect(toStemRequestSpec(blankStem())).toEqual({ spec: { kind: "TONE", durationMs: 1000, channels: 1, amplitudeDb: -6, frequencyHz: 440 }, problems: [] });
    expect(toStemRequestSpec({ ...blankStem(), kind: "CHORD", frequenciesHz: "220, x" }).problems).toEqual([{ path: "$.spec.frequenciesHz[1]", message: "Enter a number." }]);
    expect(toStemRequestSpec({ ...blankStem(), kind: "DRUM", seed: "1.5" }).problems[0]).toEqual({ path: "$.spec.seed", message: "Enter a whole number." });
  });

  it("builds the master request and names the offending placement field", () => {
    const placement = { artifactId: "stem-1", artifactVersionId: "v", label: "", gainDb: "-3", pan: "0.5", startFrame: "4800", fadeInFrames: "0", fadeOutFrames: "96" };
    const built = toMasterRequest({ placements: [placement], durationFrames: "", targetLufs: "-16", truePeakDbtp: "-1" });
    expect(built.problems).toEqual([]);
    expect(built.request).toMatchObject({ stems: [{ artifactId: "stem-1", gainDb: -3, pan: 0.5, startFrame: 4800, fadeOutFrames: 96 }], target: { integratedLufs: -16, truePeakDbtp: -1 } });
    expect(built.request).not.toHaveProperty("durationFrames");
    expect(toMasterRequest({ placements: [{ ...placement, startFrame: "soon" }], durationFrames: "", targetLufs: "-16", truePeakDbtp: "-1" }).problems)
      .toEqual([{ path: "$.stems[0].startFrame", message: "Enter a whole number." }]);
  });

  it("parses views strictly and types every host failure", () => {
    expect(parseMasterStatus({ status: 200, body: statusBody() }).maxMasterFrames).toBe(2880000);
    expect(() => parseMasterStatus({ status: 200, body: { scope: "x" } })).toThrow(DevMasterHostError);
    expect(parseStemView({ status: 201, body: stemBody() }).kind).toBe("TONE");
    expect(parseMasterView({ status: 201, body: masterBody() }).measurement.integratedLufs).toBeCloseTo(-16.01);
    const tampered = masterBody() as { wav: { sha256: string } };
    tampered.wav.sha256 = "zz";
    expect(() => parseMasterView({ status: 201, body: tampered })).toThrow(DevMasterHostError);
    expect(describeMasterFailure(new DevMasterHostError("MASTER_PARAMETERS_INVALID", 422, "bad", { path: "$.stems[0].pan" }))).toMatchObject({ tone: "invalid", path: "$.stems[0].pan" });
    expect(describeMasterFailure(new DevMasterHostError("RIGHTS_NOT_ADMITTED", 403, "x", { path: "$.stems[0].artifactId", verdict: "REVOKED" })).text).toContain("REVOKED");
    const abstained = describeMasterFailure(new DevMasterHostError("MASTER_LOUDNESS_TARGET_UNREACHABLE", 422, "x", { reason: "SILENT_INPUT" }));
    expect(abstained.tone).toBe("abstained");
    expect(abstained.text).toContain("silent");
    expect(describeMasterFailure(new DevMasterHostError("X", 0, "no response")).tone).toBe("unknown");
  });
});

describe("DevMasterPanel", () => {
  it("reads limits from the host and fails closed when mastering is unavailable", async () => {
    await mounted(fakePort());
    expect(document.querySelector("[data-status-line]")!.textContent).toContain("50 to 30000 ms");
    cleanup();
    render(React.createElement(DevMasterPanel, { masters: asPort(fakePort({}, statusBody({ masterReady: false }))) }));
    await waitFor(() => expect(document.querySelector("[data-status-line]")!.textContent).toContain("Mastering is not available"));
    expect(screen.getByRole("button", { name: "Mix and master" }).hasAttribute("disabled")).toBe(true);
  });

  it("builds a stem, adds it to the mix, masters and shows the measured loudness report with focus on the result", async () => {
    const port = fakePort();
    await mounted(port);
    fireEvent.click(screen.getByRole("button", { name: "Build stem" }));
    await waitFor(() => expect(document.querySelector("[data-stem-table]")).toBeTruthy());
    expect((port.generateStem.mock.calls[0]![0] as { requestId: string }).requestId).toBe("master-req-1");
    fireEvent.click(screen.getByRole("button", { name: "Add TONE stem-1 to the mix" }));
    fireEvent.change(screen.getByLabelText("Start (samples at 48 kHz)"), { target: { value: "4800" } });
    fireEvent.click(screen.getByRole("button", { name: "Mix and master" }));
    await waitFor(() => expect(document.querySelector("[data-master-result]")).toBeTruthy());
    const sent = port.master.mock.calls[0]![0] as { requestId: string; stems: { startFrame: number }[]; target: unknown };
    expect(sent.requestId).toBe("master-req-2");
    expect(sent.stems[0]!.startFrame).toBe(4800);
    expect(sent.target).toEqual({ integratedLufs: -16, truePeakDbtp: -1 });
    expect(document.querySelector("[data-measure='integrated-lufs']")!.textContent).toBe("-16.01 LUFS");
    expect(document.querySelector("[data-measure='true-peak']")!.textContent).toBe("-2.30 dBTP");
    expect(document.querySelector("[data-measure='clipped']")!.textContent).toBe("0");
    expect(document.querySelector("[data-target-met]")!.textContent).toContain("target and the ceiling are met");
    expect(document.querySelectorAll("[data-lineage-table] tbody tr")).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Master result" }));
    // the same request again reuses the identifier; a changed target gets a fresh one
    fireEvent.click(screen.getByRole("button", { name: "Mix and master" }));
    await waitFor(() => expect(port.master).toHaveBeenCalledTimes(2));
    expect((port.master.mock.calls[1]![0] as { requestId: string }).requestId).toBe("master-req-2");
    fireEvent.change(screen.getByLabelText("Integrated loudness target (LUFS, -30 to -9)"), { target: { value: "-18" } });
    fireEvent.click(screen.getByRole("button", { name: "Mix and master" }));
    await waitFor(() => expect(port.master).toHaveBeenCalledTimes(3));
    expect((port.master.mock.calls[2]![0] as { requestId: string }).requestId).toBe("master-req-3");
  });

  it("shows a typed refusal with its path, moves focus to the field and keeps the outcome-unknown retry identifier", async () => {
    const port = fakePort({ master: vi.fn()
      .mockRejectedValueOnce(new DevMasterHostError("MASTER_PARAMETERS_INVALID", 422, "pan must be within [-1.0, 1.0]", { path: "$.stems[0].pan" }))
      .mockRejectedValueOnce(new DevMasterHostError("OUTCOME_UNKNOWN", 0, "no response"))
      .mockImplementation(() => ok(201, masterBody())) });
    await mounted(port);
    fireEvent.click(screen.getByRole("button", { name: "Build stem" }));
    await waitFor(() => expect(document.querySelector("[data-stem-table]")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add TONE stem-1 to the mix" }));
    fireEvent.click(screen.getByRole("button", { name: "Mix and master" }));
    const failure = await waitFor(() => { const node = document.querySelector("[data-failure-code]"); expect(node).toBeTruthy(); return node!; });
    expect(failure.getAttribute("data-failure-path")).toBe("$.stems[0].pan");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Pan (-1 left to 1 right)")));
    expect(document.querySelector("[data-master-result]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mix and master" }));
    await waitFor(() => expect(document.querySelector("[data-failure-tone='unknown']")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Mix and master" }));
    await waitFor(() => expect(document.querySelector("[data-master-result]")).toBeTruthy());
    const ids = port.master.mock.calls.map((call) => (call[0] as { requestId: string }).requestId);
    expect(ids).toEqual(["master-req-2", "master-req-2", "master-req-2"]);
  });

  it("refuses a non-number locally with its path and sends nothing", async () => {
    const port = fakePort();
    await mounted(port);
    fireEvent.change(screen.getByLabelText("Duration (milliseconds)"), { target: { value: "long" } });
    fireEvent.click(screen.getByRole("button", { name: "Build stem" }));
    expect(document.querySelector("[data-problems]") ?? document.querySelector("[role=alert]")).toBeTruthy();
    expect(port.generateStem).not.toHaveBeenCalled();
  });
});
