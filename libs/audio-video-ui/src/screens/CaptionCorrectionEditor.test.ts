// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptionCorrectionEditor } from "./CaptionCorrectionEditor";
import { DevOutputsHostError, type DevHostResponse } from "./devProjectOutputs";
import {
  buildCorrectionRequest, describeCaptionFailure, draftFrom, formatTimecode, parseCaptionVersion, parseTimecode, validateDraft,
  type DevCaptionPort,
} from "./devCaptions";

afterEach(cleanup);

const V0 = `sha256:${"a".repeat(64)}`;
const V1 = `sha256:${"b".repeat(64)}`;
const machineView = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: "media.dev.caption-version.v1", captionId: "cap-machine", artifact: { artifactId: "cap-machine", artifactVersionId: V0, sha256: "a".repeat(64), contentType: "text/vtt", sizeBytes: 10 },
  kind: "LOCAL_STT_WEBVTT_UNREVIEWED",
  cues: [{ startMillis: 0, endMillis: 2000, text: "And so my fellow Americans" }, { startMillis: 2000, endMillis: 4500, text: "ask not what your country can do for you" }],
  lineage: { source: { artifactId: "audio-1" } },
  review: { available: true, reviewCaseId: "devreview.x", caseExists: false, latestDecision: "NONE", currentness: "NONE", acceptedByAssignedReviewer: false, establishesApproval: false },
  replayed: false, scope: "DEV_ONLY", ...over,
});
const correctedView = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...machineView(), captionId: "cap-corrected", artifact: { artifactId: "cap-corrected", artifactVersionId: V1, sha256: "b".repeat(64), contentType: "text/vtt", sizeBytes: 10 },
  kind: "LOCAL_CAPTION_USER_CORRECTED",
  cues: [{ startMillis: 0, endMillis: 2000, text: "And so, my fellow Americans," }, { startMillis: 2000, endMillis: 4500, text: "ask not what your country can do for you" }],
  lineage: { parent: { artifactId: "cap-machine", artifactVersionId: V0 }, machineVersion: { artifactId: "cap-machine", artifactVersionId: V0 }, correctedByPrincipalId: "test-principal-owner", correctionNumber: 1, edit: { textChanged: 1, timingChanged: 0, added: 0, removed: 0 }, source: { artifactId: "audio-1" } },
  ...over,
});
const ok = (status: number, body: unknown): Promise<DevHostResponse> => Promise.resolve({ status, body });
const fail = (status: number, code: string): Promise<never> => Promise.reject(new DevOutputsHostError(code, status, code));

function port(over: Partial<Record<keyof DevCaptionPort, unknown>> = {}) {
  return {
    getCaption: vi.fn(() => ok(200, machineView())),
    correctCaption: vi.fn(() => ok(201, correctedView())),
    ...over,
  } as unknown as DevCaptionPort & { getCaption: ReturnType<typeof vi.fn>; correctCaption: ReturnType<typeof vi.fn> };
}
const mount = (captions: DevCaptionPort, props: Record<string, unknown> = {}) =>
  render(React.createElement(CaptionCorrectionEditor, { captions, newRequestId: (() => { let n = 0; return () => `req-${++n}`; })(), ...props }));
const open = async (): Promise<void> => {
  fireEvent.change(screen.getByLabelText("Caption version id"), { target: { value: "cap-machine" } });
  fireEvent.click(screen.getByRole("button", { name: "Open caption version" }));
  await screen.findByLabelText("Cue 1 text");
};
const status = (): string => document.getElementById("caption-status")!.textContent ?? "";

describe("caption correction logic", () => {
  it("parses and formats exact timecodes and rejects anything else", () => {
    expect(parseTimecode("00:03.250")).toBe(3250);
    expect(parseTimecode("1:02:03.004")).toBe(3_723_004);
    expect(formatTimecode(3250)).toBe("00:03.250");
    expect(formatTimecode(3_723_004)).toBe("1:02:03.004");
    for (const bad of ["3.25", "00:03", "00:60.000", "00:03.25", "abc", "", "25:00:00.001"]) expect(parseTimecode(bad)).toBeNull();
  });

  it("validates ordering, overlap, markup and empties without repairing them", () => {
    const base = draftFrom([{ startMillis: 0, endMillis: 1000, text: "a" }, { startMillis: 1000, endMillis: 2000, text: "b" }]);
    expect(validateDraft(base).summary).toEqual([]);
    expect(validateDraft([{ ...base[0]!, end: "00:00.000" }]).summary[0]).toContain("end must be after");
    expect(validateDraft([base[0]!, { ...base[1]!, start: "00:00.500" }]).summary[0]).toContain("previous cue");
    expect(validateDraft([{ ...base[0]!, text: "<b>x</b>" }]).summary[0]).toContain("'<'");
    expect(validateDraft([{ ...base[0]!, text: "   " }]).summary[0]).toContain("required");
    expect(validateDraft([]).summary[0]).toContain("at least one");
  });

  it("refuses an invalid host view instead of trusting it", () => {
    expect(() => parseCaptionVersion({})).toThrow();
    expect(() => parseCaptionVersion(machineView({ scope: "PROD" }))).toThrow();
    expect(() => parseCaptionVersion(machineView({ review: { available: true, establishesApproval: true } }))).toThrow();
    expect(() => parseCaptionVersion(machineView({ cues: [{ startMillis: 5, endMillis: 5, text: "x" }] }))).toThrow();
    expect(parseCaptionVersion(machineView()).cues).toHaveLength(2);
  });

  it("binds the request to the exact edited version", () => {
    const base = parseCaptionVersion(machineView());
    const request = buildCorrectionRequest(base, draftFrom(base.cues), "req-1");
    expect(request).toMatchObject({ requestId: "req-1", baseArtifactId: "cap-machine", expectedVersionId: V0 });
    expect(() => buildCorrectionRequest(base, draftFrom(base.cues), "bad id")).toThrow();
  });

  it("describes failures with typed, non-approving wording", () => {
    expect(describeCaptionFailure(new DevOutputsHostError("CAPTION_VERSION_CONFLICT", 409, "x"))).toMatchObject({ tone: "error", discardRequest: true });
    expect(describeCaptionFailure(new DevOutputsHostError("RIGHTS_DECISION_REVOKED", 403, "x"))).toMatchObject({ tone: "denied" });
    expect(describeCaptionFailure(new DevOutputsHostError("OUTCOME_UNKNOWN", 0, "x"))).toMatchObject({ tone: "unknown", retrySameRequest: true });
    expect(describeCaptionFailure(new Error("boom"))).toMatchObject({ tone: "unknown" });
  });
});

describe("CaptionCorrectionEditor", () => {
  it("opens an exact version, edits text, saves a new version and shows lineage without approval claims", async () => {
    const captions = port();
    mount(captions);
    await open();
    expect(captions.getCaption).toHaveBeenCalledWith("cap-machine");
    expect(screen.getByRole("button", { name: "Save as new caption version" })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Cue 1 text"), { target: { value: "And so, my fellow Americans," } });
    expect(screen.getByText("You have unsaved edits.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save as new caption version" }));
    await waitFor(() => expect(status()).toContain("Saved (HTTP 201) as new version cap-corrected"));
    expect(captions.correctCaption).toHaveBeenCalledTimes(1);
    const request = captions.correctCaption.mock.calls[0]![0] as { baseArtifactId: string; expectedVersionId: string; cues: { text: string }[] };
    expect(request.baseArtifactId).toBe("cap-machine");
    expect(request.expectedVersionId).toBe(V0);
    expect(request.cues[0]!.text).toBe("And so, my fellow Americans,");
    expect(document.getElementById("caption-parent")!.textContent).toBe("cap-machine");
    expect(document.getElementById("caption-corrector")!.textContent).toBe("test-principal-owner");
    expect(document.getElementById("caption-review")!.textContent).toContain("must accept this exact version");
    expect(document.body.textContent).not.toMatch(/approved|published/iu);
    // The editor now edits the new version.
    expect(document.getElementById("caption-version-id")!.textContent).toBe("cap-corrected");
  });

  it("is keyboard operable: Ctrl+Enter saves and Alt+ArrowDown moves between cue texts", async () => {
    const captions = port();
    mount(captions);
    await open();
    const first = screen.getByLabelText("Cue 1 text");
    first.focus();
    fireEvent.change(first, { target: { value: "Edited" } });
    fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText("Cue 2 text"));
    fireEvent.keyDown(screen.getByLabelText("Cue 2 text"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(captions.correctCaption).toHaveBeenCalledTimes(1));
  });

  it("flags invalid edits accessibly and blocks saving", async () => {
    const captions = port();
    mount(captions);
    await open();
    fireEvent.change(screen.getByLabelText("Cue 2 start"), { target: { value: "00:01.000" } });
    const input = screen.getByLabelText("Cue 2 start");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(input.getAttribute("aria-describedby")!)!.textContent).toContain("previous cue");
    expect(screen.getByRole("button", { name: "Save as new caption version" })).toHaveProperty("disabled", true);
    expect(captions.correctCaption).not.toHaveBeenCalled();
  });

  it("reports a stale version as a conflict and nothing saved, and opens a fresh request after it", async () => {
    const captions = port({ correctCaption: vi.fn(() => fail(409, "CAPTION_VERSION_CONFLICT")) });
    mount(captions);
    await open();
    fireEvent.change(screen.getByLabelText("Cue 1 text"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as new caption version" }));
    await waitFor(() => expect(document.getElementById("caption-outcome")!.textContent).toContain("CONFLICT"));
    expect(document.getElementById("caption-outcome")!.getAttribute("data-outcome-code")).toBe("CAPTION_VERSION_CONFLICT");
    expect(status()).toBe("Nothing was saved.");
    fireEvent.click(screen.getByRole("button", { name: "Save as new caption version" }));
    await waitFor(() => expect(captions.correctCaption).toHaveBeenCalledTimes(2));
    expect((captions.correctCaption.mock.calls[0]![0] as { requestId: string }).requestId)
      .not.toBe((captions.correctCaption.mock.calls[1]![0] as { requestId: string }).requestId);
  });

  it("retries an unknown outcome with the same request identity", async () => {
    const correctCaption = vi.fn()
      .mockImplementationOnce(() => fail(0, "OUTCOME_UNKNOWN"))
      .mockImplementationOnce(() => ok(200, correctedView({ replayed: true })));
    const captions = port({ correctCaption });
    mount(captions);
    await open();
    fireEvent.change(screen.getByLabelText("Cue 1 text"), { target: { value: "And so, my fellow Americans," } });
    fireEvent.click(screen.getByRole("button", { name: "Save as new caption version" }));
    await waitFor(() => expect(document.getElementById("caption-outcome")!.textContent).toContain("OUTCOME UNKNOWN"));
    fireEvent.click(screen.getByRole("button", { name: "Save as new caption version" }));
    await waitFor(() => expect(status()).toContain("Replayed (HTTP 200)"));
    const ids = correctCaption.mock.calls.map((call) => (call[0] as { requestId: string }).requestId);
    expect(ids[0]).toBe(ids[1]);
  });

  it("rejects a saved version that does not descend from the edited one", async () => {
    const captions = port({ correctCaption: vi.fn(() => ok(201, correctedView({ lineage: { parent: { artifactId: "other", artifactVersionId: V0 } } }))) });
    mount(captions);
    await open();
    fireEvent.change(screen.getByLabelText("Cue 1 text"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as new caption version" }));
    await waitFor(() => expect(document.getElementById("caption-outcome")!.textContent).toContain("OUTCOME UNKNOWN"));
  });

  it("inserts and removes cues and can discard edits", async () => {
    mount(port());
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Insert cue after 2" }));
    expect(screen.getByLabelText("Cue 3 start")).toHaveProperty("value", "00:04.500");
    fireEvent.click(screen.getByRole("button", { name: "Remove cue 3" }));
    expect(screen.queryByLabelText("Cue 3 text")).toBeNull();
    fireEvent.change(screen.getByLabelText("Cue 1 text"), { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard edits" }));
    expect(screen.getByLabelText("Cue 1 text")).toHaveProperty("value", "And so my fellow Americans");
  });

  it("shows a refusal as denied and never as success when rights are revoked", async () => {
    mount(port({ correctCaption: vi.fn(() => fail(403, "RIGHTS_DECISION_REVOKED")) }));
    await open();
    fireEvent.change(screen.getByLabelText("Cue 1 text"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as new caption version" }));
    await waitFor(() => expect(document.getElementById("caption-outcome")!.textContent).toContain("Denied"));
    expect(status()).toBe("Nothing was saved.");
  });
});
