// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevDubbingPanel } from "./DevDubbingPanel";
import {
  DevDubbingHostError, describeDubbingFailure, parseDubbingCapabilities, parseDubView, parseTranslationView,
  type DevDubbingHostResponse, type DevDubbingPort,
} from "./devDubbing";

afterEach(cleanup);

const hex = (c: string): string => c.repeat(64);
const TRANSCRIPT = `sha256:${hex("a")}`;
const capabilitiesBody = (over: { targets?: string[]; voices?: Record<string, string>; translationReady?: boolean } = {}): unknown => ({
  schema: "media.dev.translation-output.v1", scope: "DEV_ONLY",
  translation: { ready: over.translationReady ?? true, engine: { modelId: "Qwen/Qwen2.5-VL-7B-Instruct" }, pairs: ["en>es"],
    admittedTargets: { en: over.targets ?? ["es"] }, maxSegments: 200, maxSegmentChars: 40 },
  dubbing: { ready: true, voices: over.voices ?? { ef_dora: "es", em_alex: "es", em_santa: "es" }, voiceCloning: "NOT_SUPPORTED",
    tempo: { available: true, minFactor: 0.8, maxFactor: 1.25 }, overflowPolicies: ["REFUSE", "ALLOW_SPILL"],
    lipTiming: { status: "SOURCE_WINDOWS_ONLY", note: "Only each segment's source speech window is recorded." } },
});
const artifact = (id: string, c: string, type: string): Record<string, unknown> => ({
  artifactId: id, artifactVersionId: `sha256:${hex(c)}`, contentType: type, sizeBytes: 3, sha256: hex(c) });
const translationBody = (c: string, texts: string[], kind = "LOCAL_TRANSLATED_TRANSCRIPT", replayed = false): unknown => ({
  schema: "media.dev.translation-output.v1", scope: "DEV_ONLY", translationId: `tr-${c}`, replayed,
  translation: { outputId: `tr-${c}`, artifact: artifact(`tr-${c}`, c, "application/json"), lineage: { kind } },
  sourceLanguage: "en", targetLanguage: "es", note: "DEV_ONLY",
  segments: texts.map((text, i) => ({ segmentId: `seg-000${i + 1}`, startMillis: i * 3000, endMillis: i * 3000 + 2000, sourceText: `Source ${i + 1}`, text })),
});
const seg = (id: string, fit: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  segmentId: id, sourceStartMillis: 0, sourceEndMillis: 2000, windowMillis: 2000, naturalDurationMillis: 2400, tempoFactor: 1.2,
  dubDurationMillis: 2000, placedStartMillis: 0, placedEndMillis: 2000, fit, overflow: fit === "OVERFLOW", overflowMillis: fit === "OVERFLOW" ? 500 : 0, ...over });
const dubBody = (replayed = false): unknown => ({
  schema: "media.dev.dub-output.v1", scope: "DEV_ONLY", dubId: "timing-1", replayed, note: "DEV_ONLY",
  outputs: { audio: { artifact: artifact("audio-1", "b", "audio/wav") }, captions: { artifact: artifact("cap-1", "c", "text/vtt") },
    timing: { artifact: artifact("timing-1", "d", "application/json") } },
  timing: { voice: "ef_dora", overflowPolicy: "REFUSE", segments: [seg("seg-0001", "TEMPO_ADJUSTED"), seg("seg-0002", "FITS", { tempoFactor: 1, naturalDurationMillis: 1500, dubDurationMillis: 1500 })],
    totals: { trackDurationMillis: 5000, tempoAdjustedCount: 1, overflowCount: 0 }, lipTiming: { status: "SOURCE_WINDOWS_ONLY", note: "Source windows only." } },
});
const ok = (status: number, body: unknown): Promise<DevDubbingHostResponse> => Promise.resolve({ status, body });
type FakePort = { [K in keyof DevDubbingPort]-?: ReturnType<typeof vi.fn> };
function fakePort(over: Partial<DevDubbingPort> = {}, caps: unknown = capabilitiesBody()): FakePort {
  return {
    getCapabilities: vi.fn(() => ok(200, caps)),
    translate: vi.fn(() => ok(201, translationBody("1", ["Hola uno", "Hola dos"]))),
    revise: vi.fn(() => ok(201, translationBody("2", ["Hola 1", "Hola dos"], "LOCAL_TRANSLATED_TRANSCRIPT_USER_REVISED"))),
    dub: vi.fn(() => ok(201, dubBody())),
    readArtifactContent: undefined,
    ...over,
  } as unknown as FakePort;
}
const asPort = (port: FakePort): DevDubbingPort => port as unknown as DevDubbingPort;
const ids = (): (() => string) => { let n = 0; return () => `dub-req-${++n}`; };

async function mounted(port: FakePort, locked = false) {
  render(React.createElement(DevDubbingPanel, { dubbing: asPort(port), locked, newRequestId: ids() }));
  await waitFor(() => expect((screen.getByLabelText("Target language") as HTMLSelectElement).options.length).toBeGreaterThan(0));
}
const fill = (id: string, version = TRANSCRIPT) => {
  fireEvent.change(screen.getByLabelText("Transcript artifact id"), { target: { value: id } });
  fireEvent.change(screen.getByLabelText(/Transcript version/u), { target: { value: version } });
};
async function translated(port: FakePort) {
  await mounted(port);
  fill("transcript-1");
  fireEvent.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() => expect(document.querySelector("[data-segment-table]")).toBeTruthy());
}

describe("DevDubbingPanel", () => {
  it("offers only the targets and Spanish voices the host reports (nothing is hard-coded)", async () => {
    await mounted(fakePort());
    expect(Array.from((screen.getByLabelText("Target language") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["es"]);
    expect(document.querySelector("[data-admitted-voices]")!.textContent).toBe("ef_dora (es), em_alex (es), em_santa (es)");
    expect(document.querySelector("[data-dubbing-facts]")!.textContent).toContain("Not supported");
    expect(document.querySelector("[data-dubbing-facts]")!.textContent).toContain("0.8 to 1.25");
    cleanup();
    await mounted(fakePort({}, capabilitiesBody({ targets: ["zz"], voices: { zz_test: "zz" } })));
    expect(document.body.textContent).not.toContain("ef_dora");
    expect(document.querySelector("[data-admitted-targets]")!.textContent).toBe("zz");
  });

  it("fails closed when translation is not ready or capabilities are unreadable", async () => {
    render(React.createElement(DevDubbingPanel, { dubbing: asPort(fakePort({}, capabilitiesBody({ translationReady: false }))) }));
    await waitFor(() => expect(document.querySelector("[data-capabilities-status]")!.textContent).toContain("not available"));
    expect(screen.getByRole("button", { name: "Translate" }).hasAttribute("disabled")).toBe(true);
    cleanup();
    render(React.createElement(DevDubbingPanel, { dubbing: asPort(fakePort({ getCapabilities: vi.fn(() => Promise.reject(new DevDubbingHostError("HTTP_ERROR", 503, "down"))) })) }));
    await waitFor(() => expect(screen.getByText(/HTTP_ERROR/u)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Retry reading capabilities" })).toBeTruthy();
  });

  it("validates the exact transcript version before any request", async () => {
    const port = fakePort();
    await mounted(port);
    fireEvent.click(screen.getByRole("button", { name: "Translate" }));
    expect(screen.getByRole("alert").textContent).toContain("transcript artifact id");
    expect(document.activeElement).toBe(screen.getByLabelText("Transcript artifact id"));
    fill("t", "latest");
    fireEvent.click(screen.getByRole("button", { name: "Translate" }));
    expect(screen.getByRole("alert").textContent).toContain("sha256:");
    expect(port.translate).not.toHaveBeenCalled();
  });

  it("translates, shows editable segments with their source windows and keeps Dub off until edits are saved", async () => {
    const port = fakePort();
    await translated(port);
    expect(port.translate).toHaveBeenCalledWith({ requestId: "dub-req-1", transcriptArtifactId: "transcript-1",
      transcriptArtifactVersionId: TRANSCRIPT, sourceLanguage: "en", targetLanguage: "es" });
    expect((screen.getByLabelText("Translation of seg-0001") as HTMLTextAreaElement).value).toBe("Hola uno");
    expect(document.querySelector('[data-segment-id="seg-0002"]')!.textContent).toContain("3.00 s to 5.00 s");
    expect(document.querySelector("caption")!.textContent).toContain("es");
    expect(document.querySelectorAll("th[scope=col]").length).toBe(4);
    expect(screen.getByRole("button", { name: "Save revision" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Dub" }).hasAttribute("disabled")).toBe(false);
    fireEvent.change(screen.getByLabelText("Translation of seg-0001"), { target: { value: "Hola 1" } });
    expect(screen.getByRole("button", { name: "Save revision" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Dub" }).hasAttribute("disabled")).toBe(true);
    expect(document.body.textContent).toContain("only a saved version can be dubbed");
    fireEvent.click(screen.getByRole("button", { name: "Save revision" }));
    await waitFor(() => expect(port.revise).toHaveBeenCalledTimes(1));
    expect(port.revise).toHaveBeenCalledWith({ requestId: "dub-req-2", baseArtifactId: "tr-1", baseArtifactVersionId: `sha256:${hex("1")}`,
      segments: [{ segmentId: "seg-0001", text: "Hola 1" }, { segmentId: "seg-0002", text: "Hola dos" }] });
    await waitFor(() => expect(document.querySelector('[data-translation-version]')!.getAttribute("data-translation-version")).toBe(`sha256:${hex("2")}`));
    expect(document.body.textContent).toContain("Human-revised version");
    expect(screen.getByRole("button", { name: "Dub" }).hasAttribute("disabled")).toBe(false);
  });

  it("dubs the saved version with the chosen voice and policy and shows the host's timing table", async () => {
    const port = fakePort();
    await translated(port);
    fireEvent.change(screen.getByLabelText("Spanish stock voice"), { target: { value: "em_alex" } });
    fireEvent.change(screen.getByLabelText("Overflow policy"), { target: { value: "ALLOW_SPILL" } });
    fireEvent.click(screen.getByRole("button", { name: "Dub" }));
    await waitFor(() => expect(document.querySelector("[data-dub-result]")).toBeTruthy());
    expect(port.dub).toHaveBeenCalledWith({ requestId: "dub-req-2", translatedArtifactId: "tr-1",
      translatedArtifactVersionId: `sha256:${hex("1")}`, voice: "em_alex", overflowPolicy: "ALLOW_SPILL" });
    const rows = document.querySelectorAll("[data-dub-result] tbody tr");
    expect(rows.length).toBe(2);
    expect(rows[0]!.getAttribute("data-fit")).toBe("TEMPO_ADJUSTED");
    expect(rows[0]!.textContent).toContain("Fits after tempo adjustment");
    expect(rows[0]!.textContent).toContain("1.2000");
    expect(rows[0]!.textContent).toContain("2400 ms");
    expect(rows[1]!.textContent).toContain("Fits (no change)");
    expect(document.querySelector("[data-timing-totals]")!.textContent).toContain("Track 5.00 s");
    expect(document.querySelector("[data-lip-timing-note]")!.textContent).toBe("Source windows only.");
    expect(document.body.textContent).toContain("Disclose it as synthetic");
  });

  it("shows a typed overflow refusal with the host's per-segment fit and registers nothing", async () => {
    const overflow = new DevDubbingHostError("DUB_TIMING_OVERFLOW", 422, "overflow", {
      overflowSegments: [{ segmentId: "seg-0001", windowMillis: 2000, naturalDurationMillis: 4000, dubDurationMillis: 3200, overflowMillis: 1200, requiredTempoFactor: 2, reason: "EXCEEDS_WINDOW_AT_MAX_TEMPO" }],
      segments: [seg("seg-0001", "OVERFLOW", { overflowMillis: 1200, dubDurationMillis: 3200, tempoFactor: 1.25 })],
    });
    const port = fakePort({ dub: vi.fn(() => Promise.reject(overflow)) });
    await translated(port);
    fireEvent.click(screen.getByRole("button", { name: "Dub" }));
    await waitFor(() => expect(document.querySelector('[data-failure-code="DUB_TIMING_OVERFLOW"]')).toBeTruthy());
    expect(document.querySelector("[data-dub-result]")).toBeNull();
    const failure = document.querySelector('[data-failure-code="DUB_TIMING_OVERFLOW"]')!;
    expect(failure.getAttribute("data-failure-tone")).toBe("overflow");
    expect(failure.textContent).toContain("Nothing was registered and no audio was truncated");
    expect(failure.querySelector("[data-overflow-segment=seg-0001]")!.textContent).toContain("needs a tempo factor of 2.00");
    expect(failure.querySelector("tbody tr")!.getAttribute("data-fit")).toBe("OVERFLOW");
    expect(failure.textContent).toContain("Overflow");
  });

  it("reuses the same request identifier for an unchanged retry after an unknown outcome", async () => {
    const dub = vi.fn().mockImplementationOnce(() => Promise.reject(new DevDubbingHostError("DUB_OUTCOME_UNKNOWN", 503, "ended")))
      .mockImplementation(() => ok(200, dubBody(true)));
    const port = fakePort({ dub });
    await translated(port);
    fireEvent.click(screen.getByRole("button", { name: "Dub" }));
    await waitFor(() => expect(document.querySelector('[data-failure-tone="unknown"]')).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Dub" }));
    await waitFor(() => expect(document.querySelector("[data-dub-result]")).toBeTruthy());
    expect(dub.mock.calls[0]![0].requestId).toBe(dub.mock.calls[1]![0].requestId);
    expect(document.querySelector("[data-timing-totals]")!.textContent).toContain("Replayed");
  });

  it("plays the dub only after both digests match and refuses wrong bytes", async () => {
    const read = vi.fn(async () => ({ status: 200, contentType: "audio/wav", bytes: new Uint8Array([1, 2, 3]) }));
    const port = fakePort({ readArtifactContent: read });
    await translated(port);
    fireEvent.click(screen.getByRole("button", { name: "Dub" }));
    await waitFor(() => expect(document.querySelector("[data-dub-result]")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Load dubbed audio/u }));
    await waitFor(() => expect(document.querySelector('[data-playback-state="failed"]')).toBeTruthy());
    expect(document.querySelector("[data-verified-preview]")).toBeNull();
    expect(document.querySelector("[data-playback-status]")!.textContent).toContain("CONTENT_");
  });

  it("is inert while locked and parses hosts strictly", () => {
    expect(() => parseDubbingCapabilities({ scope: "OTHER" })).toThrow(DevDubbingHostError);
    expect(() => parseTranslationView({ status: 200, body: { scope: "DEV_ONLY" } })).toThrow(DevDubbingHostError);
    expect(() => parseDubView({ status: 200, body: { scope: "DEV_ONLY", outputs: {}, timing: { segments: [] } } })).toThrow(DevDubbingHostError);
    const bad = translationBody("1", ["x"]) as { translation: { artifact: { sha256: string } } };
    bad.translation.artifact.sha256 = hex("9");
    expect(() => parseTranslationView({ status: 201, body: bad })).toThrow(DevDubbingHostError);
    expect(describeDubbingFailure(new Error("boom")).tone).toBe("unknown");
    expect(describeDubbingFailure(new DevDubbingHostError("LANGUAGE_NOT_ADMITTED", 422, "x", { admittedTargets: ["es"] })).text).toContain("admitted: es");
    expect(describeDubbingFailure(new DevDubbingHostError("RIGHTS_DECISION_REVOKED", 403, "x")).text).toContain("revoked");
  });

  it("disables every control while locked", async () => {
    await mounted(fakePort(), true);
    expect(screen.getByRole("button", { name: "Translate" }).hasAttribute("disabled")).toBe(true);
    expect((screen.getByLabelText("Transcript artifact id") as HTMLInputElement).disabled).toBe(true);
  });
});
