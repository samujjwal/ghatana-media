// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevCreativeOutputsPanel } from "./DevCreativeOutputsPanel";
import {
  DevCreativeHostError, buildAudioRepairRequest, buildSimulationRequest, buildSpatialGlbRequest, emptySimulationForm,
  exampleSimulationForm, parseCreativeView, SPATIAL_RIG_TEMPLATE, type DevCreativeHostResponse, type DevCreativeOutputsPort,
} from "./devCreativeOutputs";

afterEach(cleanup);

const SHA = "c".repeat(64);
const SRC_VERSION = `sha256:${"a".repeat(64)}`;
const artifact = (id: string, contentType: string) => ({ artifactId: id, artifactVersionId: `sha256:${SHA}`, contentType, sizeBytes: 4321, sha256: SHA });
const audioBody = (over: { replayed?: boolean; sourceVersion?: string; id?: string } = {}): unknown => ({
  schema: "x", outputId: over.id ?? "out-audio-1", replayed: over.replayed ?? false, scope: "DEV_ONLY", note: "DEV_ONLY engine output",
  artifact: artifact(over.id ?? "out-audio-1", "audio/wav"),
  lineage: { kind: "AUDIO_REPAIR_CANDIDATE", engine: "declipper-1", comparisonEngine: "compare-1", requestId: "req-1",
    source: { artifactId: "src-1", artifactVersionId: over.sourceVersion ?? SRC_VERSION, sha256: "a".repeat(64) },
    profile: { threshold: 0.94, maxRunFrames: 64 },
    metrics: { changedSampleCount: 17, sourcePeak: 32767, repairedPeak: 30800, hasIndependentReference: false, snrDbVsReference: null } },
});
const simBody = (over: { replayed?: boolean } = {}): unknown => ({
  schema: "x", outputId: "out-sim-1", replayed: over.replayed ?? false, scope: "DEV_ONLY", artifact: artifact("out-sim-1", "application/json"),
  lineage: { kind: "SIMULATED_OUTPUT_NOT_MEASUREMENT", engine: "sim-1", requestId: "req-1", evidenceClass: "DETERMINISTIC_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE",
    validation: { disposition: "VALID", findings: [], referenceAuthority: "SELF_CONTENT_ADDRESSED_REQUEST_PAYLOAD_ONLY" },
    inputReferences: [{ role: "PHYSICAL_MODEL", identity: "request.scenario.model", sha256: "d".repeat(64) }],
    solverStats: { acceptedSteps: 8, solverIterations: 16, deterministic: true }, scenarioSha256: "e".repeat(64) },
});
const simDocument = (): unknown => ({
  scope: "DEV_ONLY", outputKind: "SIMULATED_OUTPUT_NOT_MEASUREMENT", disclaimer: "Deterministic model output from a declared scenario. It is not a measurement.",
  units: { time: "SECOND", position: "METER", velocity: "METER_PER_SECOND", acceleration: "METER_PER_SECOND_SQUARED", totalEnergy: "JOULE" },
  observations: [
    { time: 0, position: 0, velocity: 0, acceleration: 3, totalEnergy: 0 },
    { time: 2, position: 6, velocity: 6, acceleration: 3, totalEnergy: 36 },
  ],
});
const spatialBody = (over: { productionGrant?: unknown } = {}): unknown => ({
  schema: "x", outputId: "out-glb-1", replayed: false, scope: "DEV_ONLY", artifact: artifact("out-glb-1", "model/gltf-binary"),
  lineage: { kind: "SPATIAL_GLB_EXPORT", engine: "spatial-1", requestId: "req-1", rigId: "rig-1", sourceProjectRevisionRef: "project:edit:revision-8",
    sources: [{ artifactId: "src-1", artifactVersionId: SRC_VERSION, sha256: "a".repeat(64) }],
    coordinateFrame: { frameRef: "urn:media:frame:glb", frameVersionRef: "v1", handedness: "RIGHT_HANDED", axisDirections: ["POS_X", "POS_Y", "POS_Z"] },
    timeEncoding: "FLOAT32_SECONDS", lossDisposition: "FLOAT32_APPROXIMATION",
    float32LossFields: ["animation.inputTimeSeconds", "animation.outputTranslation", "animation.outputRotation"],
    rightsDecision: { authority: "DEV_ONLY_OWNER_SCOPE_VISIBILITY", outcome: "ELIGIBLE", productionGrant: over.productionGrant ?? false } },
});

const ok = (status: number, body: unknown): Promise<DevCreativeHostResponse> => Promise.resolve({ status, body });
const fail = (status: number, code: string, details?: Record<string, unknown>): Promise<never> =>
  Promise.reject(new DevCreativeHostError(code, status, code, details));
type FakePort = { [K in keyof DevCreativeOutputsPort]-?: ReturnType<typeof vi.fn> };
function fakePort(over: Partial<DevCreativeOutputsPort> = {}, withDocument = false): FakePort {
  return {
    repairAudio: vi.fn(() => ok(201, audioBody())),
    simulate: vi.fn(() => ok(201, simBody())),
    exportSpatialGlb: vi.fn(() => ok(201, spatialBody())),
    getOutput: vi.fn(() => ok(200, audioBody({ replayed: true }))),
    readSimulationDocument: withDocument ? vi.fn(() => ok(200, simDocument())) : undefined,
    ...over,
  } as never;
}
let ids = 0;
const nextId = (): string => `req-${++ids}`;
const mount = (port: FakePort) => render(React.createElement(DevCreativeOutputsPanel, { outputs: port as unknown as DevCreativeOutputsPort, newRequestId: nextId }));
const type = (label: string | RegExp, value: string): void => { fireEvent.change(screen.getByLabelText(label), { target: { value } }); };
const click = (name: string | RegExp): void => { fireEvent.click(screen.getByRole("button", { name })); };
const text = (id: string): string => document.getElementById(id)?.textContent ?? "";
const fillAudio = (): void => {
  type("Source artifact ID", "src-1"); type("Exact source artifact version", SRC_VERSION);
  type(/Clipping threshold/u, "0.94"); type(/Maximum clipped run/u, "64");
};

describe("audio repair", () => {
  it("submits the explicit profile and shows id, version, sha, lineage and engine sample statistics", async () => {
    const port = fakePort(); mount(port); fillAudio();
    click("Repair exact source version");
    await waitFor(() => expect(text("audio-status")).toContain("Created (HTTP 201)"));
    expect(port.repairAudio).toHaveBeenCalledWith({ requestId: "req-" + ids, source: { artifactId: "src-1", artifactVersionId: SRC_VERSION }, profile: { threshold: 0.94, maxRunFrames: 64 } });
    const result = document.getElementById("creative-result")!;
    expect(result.textContent).toContain("out-audio-1");
    expect(result.textContent).toContain(`sha256:${SHA}`);
    expect(result.textContent).toContain(SHA);
    expect(result.textContent).toContain(SRC_VERSION);
    expect(screen.getByLabelText("Engine sample statistics").textContent).toContain("changedSampleCount17");
    expect(screen.getByLabelText("Engine sample statistics").textContent).toContain("hasIndependentReferencefalse");
    expect(result.textContent).toContain("not a quality assessment");
  });

  it("never phrases metrics as quality: every mention of quality is negated and no improvement wording appears", async () => {
    const port = fakePort(); mount(port); fillAudio(); click("Repair exact source version");
    await waitFor(() => screen.getByLabelText("Engine sample statistics"));
    const all = document.body.textContent ?? "";
    for (const match of all.matchAll(/quality/giu)) expect(all.slice(Math.max(0, match.index - 6), match.index).toLowerCase()).toMatch(/(not|no) (a )?$/u);
    expect(all).not.toMatch(/improv|better|cleaner|restored|enhanced|good audio|snr gain/iu);
  });

  it("keeps one stable requestId across retries of the same payload and rotates it when the payload changes", async () => {
    const port = fakePort({ repairAudio: vi.fn().mockImplementationOnce(() => fail(502, "CREATIVE_OUTPUT_REGISTRATION_FAILED")).mockImplementation(() => ok(201, audioBody())) });
    mount(port); fillAudio(); click("Repair exact source version");
    await waitFor(() => expect(text("audio-status")).toContain("CREATIVE_OUTPUT_REGISTRATION_FAILED"));
    expect(screen.getByRole("alert").textContent).toContain("Not registered");
    click("Retry with the same request identity");
    await waitFor(() => expect(text("audio-status")).toContain("Created (HTTP 201)"));
    const [first, second] = port.repairAudio.mock.calls.map((call) => (call[0] as { requestId: string }).requestId);
    expect(second).toBe(first);
    type(/Maximum clipped run/u, "65"); click("Repair exact source version");
    await waitFor(() => expect(port.repairAudio).toHaveBeenCalledTimes(3));
    expect((port.repairAudio.mock.calls[2]![0] as { requestId: string }).requestId).not.toBe(first);
  });

  it("shows a replay (200) distinctly from a created (201) output", async () => {
    const port = fakePort({ repairAudio: vi.fn(() => ok(200, audioBody({ replayed: true }))) }); mount(port); fillAudio();
    click("Repair exact source version");
    await waitFor(() => expect(text("audio-status")).toContain("Replayed (HTTP 200)"));
    expect(text("creative-result-title")).toContain("replayed");
  });

  it("types the 422 nothing-to-repair refusal with no output", async () => {
    const port = fakePort({ repairAudio: vi.fn(() => fail(422, "AUDIO_REPAIR_NOTHING_TO_REPAIR")) }); mount(port); fillAudio();
    click("Repair exact source version");
    await waitFor(() => expect(text("audio-status")).toContain("AUDIO_REPAIR_NOTHING_TO_REPAIR"));
    expect(text("audio-status")).toContain("No clipped samples");
    expect(document.getElementById("creative-result")).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry with the same request identity/u })).toBeNull();
  });

  it("409 discards the identity so the next submission is new", async () => {
    const port = fakePort({ repairAudio: vi.fn().mockImplementationOnce(() => fail(409, "CREATIVE_REQUEST_ID_REUSED")).mockImplementation(() => ok(201, audioBody())) });
    mount(port); fillAudio(); click("Repair exact source version");
    await waitFor(() => expect(text("audio-status")).toContain("CONFLICT"));
    click("Repair exact source version");
    await waitFor(() => expect(text("audio-status")).toContain("Created"));
    const [first, second] = port.repairAudio.mock.calls.map((call) => (call[0] as { requestId: string }).requestId);
    expect(second).not.toBe(first);
  });

  it("refuses a body whose lineage names another source version", async () => {
    const port = fakePort({ repairAudio: vi.fn(() => ok(201, audioBody({ sourceVersion: "sha256:other" }))) }); mount(port); fillAudio();
    click("Repair exact source version");
    await waitFor(() => expect(text("audio-status")).toContain("INVALID_RESPONSE"));
    expect(document.getElementById("creative-result")).toBeNull();
  });

  it("does not send an incomplete or out-of-range profile and invents no defaults", () => {
    const port = fakePort(); mount(port);
    click("Repair exact source version");
    expect(port.repairAudio).not.toHaveBeenCalled();
    expect(document.getElementById("audio-errors")!.textContent).toMatch(/Threshold must be/u);
    expect((screen.getByLabelText(/Clipping threshold/u) as HTMLInputElement).value).toBe("");
    expect(buildAudioRepairRequest({ artifactId: "a", artifactVersionId: "v", threshold: "0.2", maxRunFrames: "4" }, "r").ok).toBe(false);
    expect(buildAudioRepairRequest({ artifactId: "a", artifactVersionId: "v", threshold: "1", maxRunFrames: "0" }, "r").ok).toBe(false);
  });
});

describe("simulation", () => {
  const loadExample = (): void => click(/Load worked example/u);

  it("submits the bounded scenario with units and always shows the not-a-measurement label", async () => {
    const port = fakePort({}, true); mount(port);
    expect(screen.getByLabelText("Simulated output label").textContent).toContain("SIMULATED_OUTPUT_NOT_MEASUREMENT");
    loadExample(); click("Run simulation");
    await waitFor(() => expect(text("simulation-status")).toContain("Created (HTTP 201)"));
    const request = port.simulate.mock.calls[0]![0] as { scenario: { model: Record<string, unknown>; invariants: unknown[] } };
    expect(request.scenario.model).toMatchObject({ type: "CONSTANT_FORCE", mass: { value: { value: 2, unit: "KILOGRAM" } }, force: { value: { value: 6, unit: "NEWTON" } } });
    expect(request.scenario.invariants).toHaveLength(1);
    await waitFor(() => screen.getByLabelText("Simulated observation series"));
    expect(screen.getByLabelText("Simulated observation series").textContent).toContain("position (METER)");
    expect(screen.getByLabelText("Simulated observation series").textContent).toContain("totalEnergy (JOULE)");
    expect(document.getElementById("creative-result")!.textContent).toContain("SIMULATED_OUTPUT_NOT_MEASUREMENT");
    expect(document.getElementById("creative-result")!.textContent).toContain("not a measurement");
  });

  it("says plainly that the series is not displayed when the host offers no content route", async () => {
    const port = fakePort(); mount(port); loadExample(); click("Run simulation");
    await waitFor(() => screen.getByText(/exposes no DEV_ONLY content route/u));
    expect(screen.queryByLabelText("Simulated observation series")).toBeNull();
    expect(document.getElementById("creative-result")!.textContent).toContain("SIMULATED_OUTPUT_NOT_MEASUREMENT");
  });

  it("shows validator findings and no output for REJECTED, and the ABSTAIN text", async () => {
    const findings = [{ reason: "SEMANTIC_INVARIANT_FAILED", subject: "terminal-position", detail: "expected 99 got 6" }];
    const port = fakePort({ simulate: vi.fn().mockImplementationOnce(() => fail(422, "SIMULATION_VALIDATION_REJECTED", { disposition: "REJECTED", findings }))
      .mockImplementation(() => fail(422, "SIMULATION_VALIDATION_ABSTAIN", { disposition: "ABSTAIN", findings: [] })) });
    mount(port); loadExample(); click("Run simulation");
    await waitFor(() => expect(text("simulation-status")).toContain("SIMULATION_VALIDATION_REJECTED"));
    expect(screen.getByLabelText("Validator findings").textContent).toContain("SEMANTIC_INVARIANT_FAILED");
    expect(screen.getByLabelText("Validator findings").textContent).toContain("expected 99 got 6");
    expect(document.getElementById("creative-result")).toBeNull();
    expect(screen.getByLabelText("Simulated output label")).toBeTruthy();
    click("Run simulation");
    await waitFor(() => expect(text("simulation-status")).toContain("SIMULATION_VALIDATION_ABSTAIN"));
    expect(document.getElementById("creative-result")).toBeNull();
  });

  it("switches to the spring model fields and refuses a unit-less or non-numeric entry locally", () => {
    const port = fakePort(); mount(port);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "HARMONIC_SPRING" } });
    expect(document.getElementById("sim-springConstant-unit")).not.toBeNull();
    expect(document.getElementById("sim-force-unit")).toBeNull();
    click("Run simulation");
    expect(port.simulate).not.toHaveBeenCalled();
    expect(document.getElementById("simulation-errors")!.textContent).toMatch(/enter a finite number/u);
    const built = buildSimulationRequest({ ...exampleSimulationForm(), maxIterations: "0" }, "r");
    expect(built.ok).toBe(false);
    expect(buildSimulationRequest(emptySimulationForm(), "r").ok).toBe(false);
  });

  it("allows submitting with no invariant so the host's ABSTAIN is observable", () => {
    const built = buildSimulationRequest({ ...exampleSimulationForm(), invariantId: "" }, "r");
    expect(built.ok && (built.request.scenario as { invariants: unknown[] }).invariants).toEqual([]);
  });

  it("refuses a registered body whose validation is not VALID", () => {
    const body = simBody() as { lineage: { validation: { disposition: string } } };
    body.lineage.validation.disposition = "ABSTAIN";
    expect(() => parseCreativeView(body)).toThrow(/VALID/u);
  });
});

describe("spatial GLB", () => {
  const goodRig = (): string => JSON.stringify({ ...JSON.parse(SPATIAL_RIG_TEMPLATE), sourceVersions: [{ artifactId: "src-1", artifactVersionId: SRC_VERSION }] });

  it("validates the rig shape locally and refuses the placeholder template", () => {
    const port = fakePort(); mount(port);
    click(/Insert rig template/u); click("Export GLB");
    expect(port.exportSpatialGlb).not.toHaveBeenCalled();
    expect(document.getElementById("spatial-errors")!.textContent).toMatch(/real artifactId/u);
    expect(buildSpatialGlbRequest("{", "r").ok).toBe(false);
    const bad = JSON.parse(goodRig()); bad.tracks.root[0].time.denominator = 0;
    expect(buildSpatialGlbRequest(JSON.stringify(bad), "r").ok).toBe(false);
    const extra = JSON.parse(goodRig()); extra.surprise = 1;
    expect(buildSpatialGlbRequest(JSON.stringify(extra), "r").ok).toBe(false);
    const quat = JSON.parse(goodRig()); quat.bones[0].restPose.orientation = [0, 0, 1];
    expect(buildSpatialGlbRequest(JSON.stringify(quat), "r").ok).toBe(false);
    expect(buildSpatialGlbRequest(goodRig(), "r").ok).toBe(true);
  });

  it("exports and shows lineage with float32LossFields and the DEV_ONLY rights decision (productionGrant=false)", async () => {
    const port = fakePort(); mount(port); type("Rig JSON", goodRig()); click("Export GLB");
    await waitFor(() => expect(text("spatial-status")).toContain("Created (HTTP 201)"));
    const sent = port.exportSpatialGlb.mock.calls[0]![0] as { requestId: string; rig: { id: string } };
    expect(sent.rig.id).toBe("rig-1");
    const result = document.getElementById("creative-result")!;
    expect(result.textContent).toContain("float32LossFields");
    expect(result.textContent).toContain("animation.outputRotation");
    expect(result.textContent).toContain("productionGrant=false");
    expect(result.textContent).toContain("DEV_ONLY_OWNER_SCOPE_VISIBILITY");
    expect(result.textContent).toContain(`src-1@${SRC_VERSION}`);
    expect(screen.getByLabelText("Rights decision").getAttribute("data-production-grant")).toBe("false");
  });

  it("rejects a host body that claims a production grant", () => {
    expect(() => parseCreativeView(spatialBody({ productionGrant: true }))).toThrow(/productionGrant=false/u);
  });

  it("types the 404 missing-source refusal", async () => {
    const port = fakePort({ exportSpatialGlb: vi.fn(() => fail(404, "SOURCE_VERSION_NOT_FOUND")) }); mount(port); type("Rig JSON", goodRig()); click("Export GLB");
    await waitFor(() => expect(text("spatial-status")).toContain("SOURCE_VERSION_NOT_FOUND"));
    expect(text("spatial-status")).toContain("exact source artifact version");
  });
});

describe("reopen and shared outcomes", () => {
  it("reopens by id and labels it reopened", async () => {
    const port = fakePort({ getOutput: vi.fn(() => ok(200, audioBody({ id: "out-9" }))) }); mount(port);
    type("Output ID", "out-9"); click("Reopen output from the host");
    await waitFor(() => expect(text("reopen-status")).toContain("Reopened output out-9"));
    expect(port.getOutput).toHaveBeenCalledWith("out-9");
    expect(text("creative-result-title")).toContain("reopened");
  });

  it("refuses a reopened body for a different id", async () => {
    const port = fakePort(); mount(port); type("Output ID", "out-9"); click("Reopen output from the host");
    await waitFor(() => expect(text("reopen-status")).toContain("INVALID_RESPONSE"));
    expect(document.getElementById("creative-result")).toBeNull();
  });

  it.each([
    [404, "CREATIVE_OUTPUT_NOT_FOUND", /not available in this tenant and owner scope/u, "error"],
    [403, "ARTIFACT_PERMISSION_REQUIRED", /Denied/u, "denied"],
    [503, "MEDIA_UNAVAILABLE", /unavailable or not enabled/u, "unavailable"],
  ])("types %i %s on reopen", async (status, code, pattern, tone) => {
    const port = fakePort({ getOutput: vi.fn(() => fail(status as number, code as string)) }); mount(port);
    type("Output ID", "out-1"); click("Reopen output from the host");
    await waitFor(() => expect(text("reopen-status")).toMatch(pattern as RegExp));
    expect(document.querySelector("#reopen-status + [role=alert]")!.getAttribute("data-outcome")).toBe(tone);
  });

  it("an unobserved POST outcome is unknown and retries with the same identity", async () => {
    const port = fakePort({ repairAudio: vi.fn().mockImplementationOnce(() => fail(0, "OUTCOME_UNKNOWN")).mockImplementation(() => ok(200, audioBody({ replayed: true }))) });
    mount(port); fillAudio(); click("Repair exact source version");
    await waitFor(() => expect(text("audio-status")).toContain("OUTCOME_UNKNOWN"));
    click("Retry with the same request identity");
    await waitFor(() => expect(text("audio-status")).toContain("Replayed"));
    expect(port.repairAudio.mock.calls[1]![0]).toEqual(port.repairAudio.mock.calls[0]![0]);
  });

  it("is a labelled DEV_ONLY surface with live regions and native controls", () => {
    mount(fakePort());
    expect(screen.getByRole("heading", { name: /Creative outputs · DEV_ONLY/u })).toBeTruthy();
    for (const id of ["audio-status", "simulation-status", "spatial-status", "reopen-status"]) {
      expect(document.getElementById(id)!.getAttribute("aria-live")).toBe("polite");
    }
    expect(document.querySelectorAll("div[onclick], span[onclick]")).toHaveLength(0);
  });
});
