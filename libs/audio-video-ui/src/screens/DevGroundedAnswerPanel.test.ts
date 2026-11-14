// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "./devArtifactContent";
import { DevGroundedAnswerPanel } from "./DevGroundedAnswerPanel";
import {
  DevGroundedHostError, boxPercent, describeGroundedFailure, formatSeconds, parseGroundedAnswerView, playerSeconds,
  type DevGroundedAnswerPort,
} from "./devGroundedAnswer";

afterEach(cleanup);

const SOURCE_BYTES = new TextEncoder().encode("fixture video bytes");
let SOURCE_SHA = "";
const CONTAINER_START = 4_957_000;
const frame = { ptsTicks: 51200, timebase: "1/10240", frameNumber: 0, width: 640, height: 360 };
const evidence = () => [
  { evidenceId: "T0", kind: "TRANSCRIPT_SEGMENT", startMicros: 5_300_000, endMicros: 9_100_000, text: "Quarterly revenue grew by twelve percent", origin: "whisper.cpp" },
  { evidenceId: "F0", kind: "FRAME", startMicros: 5_000_000, endMicros: 5_000_000, frame, text: "a title card", origin: "florence" },
  { evidenceId: "F0.S0", kind: "FRAME_TEXT", startMicros: 5_000_000, endMicros: 5_000_000, frame, box: { x: 64, y: 36, width: 320, height: 72 }, text: "QUARTERLY REPORT", origin: "florence" },
];
const body = (over: { replayed?: boolean; claims?: unknown[]; flagged?: unknown[]; evidence?: unknown[]; status?: string } = {}): unknown => ({
  schema: "media.dev.grounded-answer.v1", scope: "DEV_ONLY", outputId: "out-1", replayed: over.replayed ?? false,
  artifact: { artifactId: "out-1", artifactVersionId: `sha256:${"c".repeat(64)}`, contentType: "application/json", sizeBytes: 100, sha256: "c".repeat(64) },
  document: {
    schema: "media.dev.grounded-answer.v1", requestId: "req-1", question: "What is said and shown?",
    source: { artifactId: "src-1", artifactVersionId: `sha256:${SOURCE_SHA}`, sha256: SOURCE_SHA, contentType: "video/mp4" },
    sourceClock: { clockId: "container-clock:abc", containerStartMicros: CONTAINER_START, containerDurationMicros: 6_000_000 },
    children: [{ kind: "STT", status: "COMPLETED", evidenceCount: 1 }, { kind: "VISION", status: "COMPLETED", evidenceCount: 2 },
      { kind: "DOCUMENT_INTELLIGENCE", status: "UNAVAILABLE", reason: "no DI gateway", evidenceCount: 0 }],
    evidenceCompleteness: "COMPLETE", evidence: over.evidence ?? evidence(),
    answer: { status: over.status ?? "PARTIALLY_GROUNDED",
      claims: over.claims ?? [{ claimId: "C0", text: "Revenue grew twelve percent", evidenceIds: ["T0"], status: "GROUNDED" },
        { claimId: "C1", text: "The title reads QUARTERLY REPORT", evidenceIds: ["F0.S0", "F0"], status: "GROUNDED" }],
      flaggedClaims: over.flagged ?? [{ text: "The CEO is smiling", evidenceIds: ["T99"], flags: ["UNKNOWN_EVIDENCE_ID:T99"], status: "NOT_GROUNDED" }] },
  },
});

function port(over: Partial<DevGroundedAnswerPort> = {}): { [K in keyof DevGroundedAnswerPort]-?: ReturnType<typeof vi.fn> } {
  return {
    ask: vi.fn(() => Promise.resolve({ status: 201, body: body() })),
    get: vi.fn(() => Promise.resolve({ status: 200, body: body({ replayed: true }) })),
    readArtifactContent: vi.fn(() => Promise.resolve({ status: 200, contentType: "video/mp4", bytes: SOURCE_BYTES })),
    ...over,
  } as never;
}

beforeEach(async () => {
  SOURCE_SHA = await sha256Hex(SOURCE_BYTES);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:fixture"), revokeObjectURL: vi.fn() }));
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
});

async function ask(p = port()) {
  render(React.createElement(DevGroundedAnswerPanel, { answers: p as never, newRequestId: () => "req-ui-1" }));
  fireEvent.change(screen.getByLabelText("Source video artifact ID"), { target: { value: "src-1" } });
  fireEvent.change(screen.getByLabelText(/Exact source version/u), { target: { value: `sha256:${SOURCE_SHA}` } });
  fireEvent.change(screen.getByLabelText(/Question about the video/u), { target: { value: "What is said and shown?" } });
  fireEvent.click(screen.getByRole("button", { name: "Ask with citations" }));
  await screen.findByRole("heading", { name: /Answer to/u });
  return p;
}

describe("grounded answer parsing", () => {
  it("parses a valid view and demotes a claim whose citation is not in the evidence", () => {
    const view = parseGroundedAnswerView(body({ claims: [
      { claimId: "C0", text: "ok", evidenceIds: ["T0"], status: "GROUNDED" },
      { claimId: "C1", text: "invented", evidenceIds: ["T7"], status: "GROUNDED" },
      { claimId: "C2", text: "uncited", evidenceIds: [], status: "GROUNDED" }] }));
    expect(view.claims.map((c) => c.claimId)).toEqual(["C0"]);
    expect(view.notGrounded.map((c) => [c.text, c.by, c.flags[0]])).toEqual([
      ["invented", "client", "CITED_ID_NOT_IN_EVIDENCE:T7"], ["uncited", "client", "UNCITED"], ["The CEO is smiling", "host", "UNKNOWN_EVIDENCE_ID:T99"]]);
  });

  it("refuses malformed or contradictory responses", () => {
    const base = body() as { document: { evidence: unknown[] } };
    expect(() => parseGroundedAnswerView({ ...(base as object), scope: "PRODUCTION" })).toThrow(DevGroundedHostError);
    expect(() => parseGroundedAnswerView(body({ evidence: [{ ...evidence()[2], box: { x: 600, y: 36, width: 320, height: 72 } }] }))).toThrow(/outside its frame/u);
    expect(() => parseGroundedAnswerView(body({ evidence: [evidence()[0], evidence()[0]] }))).toThrow(/duplicate/u);
    expect(() => parseGroundedAnswerView(body({ evidence: [{ ...evidence()[0], endMicros: 1 }] }))).toThrow(/ends before/u);
    expect(() => parseGroundedAnswerView(body(), { outputId: "other" })).toThrow(/does not match/u);
    expect(() => parseGroundedAnswerView(null)).toThrow(DevGroundedHostError);
  });

  it("computes player time from the container start_time and box percentages from the frame", () => {
    const clock = { containerStartMicros: CONTAINER_START };
    expect(playerSeconds({ startMicros: 5_300_000 }, clock)).toBeCloseTo(0.343, 3);
    expect(playerSeconds({ startMicros: 1_000_000 }, clock)).toBe(0);
    expect(formatSeconds(65.04)).toBe("1:05.0");
    expect(boxPercent({ frame, box: { x: 64, y: 36, width: 320, height: 72 } })).toEqual({ left: 10, top: 10, width: 50, height: 20 });
    expect(boxPercent({ frame, box: null })).toBeNull();
  });

  it("describes outcomes without over-claiming", () => {
    expect(describeGroundedFailure(new DevGroundedHostError("OUTCOME_UNKNOWN", 0, "x")).tone).toBe("unknown");
    expect(describeGroundedFailure(new DevGroundedHostError("GROUNDED_OUTCOME_UNKNOWN", 503, "x")).tone).toBe("unknown");
    expect(describeGroundedFailure(new DevGroundedHostError("RIGHTS_REVOKED", 403, "x")).tone).toBe("denied");
    expect(describeGroundedFailure(new DevGroundedHostError("SOURCE_CLOCK_MISMATCH", 409, "x")).tone).toBe("refused");
    expect(describeGroundedFailure(new DevGroundedHostError("LOCAL_VISION_UNAVAILABLE", 503, "x")).tone).toBe("unavailable");
  });
});

describe("grounded answer panel", () => {
  it("lists grounded claims with citation buttons and keeps flagged claims free of seek controls", async () => {
    await ask();
    const claims = screen.getByRole("list", { name: "Grounded claims" });
    expect(within(claims).getAllByRole("listitem", { name: "" }).length).toBeGreaterThan(0);
    expect(screen.getByText("Revenue grew twelve percent")).toBeTruthy();
    const flagged = screen.getByRole("list", { name: "Claims that are not grounded" });
    expect(within(flagged).getByText(/NOT GROUNDED/u)).toBeTruthy();
    expect(within(flagged).getByText(/UNKNOWN_EVIDENCE_ID:T99/u)).toBeTruthy();
    expect(within(flagged).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByTestId("answer-status").textContent).toContain("PARTIALLY GROUNDED");
    const children = screen.getByRole("table", { name: "Evidence children" });
    expect(within(children).getByText(/UNAVAILABLE · no DI gateway/u)).toBeTruthy();
  });

  it("verifies the exact source bytes before offering the player", async () => {
    const p = await ask();
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    expect(p.readArtifactContent).toHaveBeenCalledWith(expect.objectContaining({ artifactId: "src-1", artifactVersionId: `sha256:${SOURCE_SHA}` }));
    expect(document.querySelector("video")?.getAttribute("aria-label")).toBe("Source video for the grounded answer");
  });

  it("a frame-text citation seeks the player to its time and highlights the cited box", async () => {
    await ask();
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    const button = screen.getByRole("button", { name: /On-screen text citation F0\.S0 at 0:00\.0/u });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    const video = document.querySelector("video") as HTMLVideoElement;
    expect(video.currentTime).toBeCloseTo(0.043, 3);
    const box = await screen.findByTestId("citation-box");
    expect(box.getAttribute("role")).toBe("img");
    expect(box.getAttribute("aria-label")).toContain("QUARTERLY REPORT");
    expect((box as HTMLElement).style.left).toBe("10%");
    expect((box as HTMLElement).style.width).toBe("50%");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("citation-announcement").textContent).toContain("Player moved to 0:00.0");
    expect(screen.getByTestId("active-citation").getAttribute("data-evidence-id")).toBe("F0.S0");
    expect(document.querySelector("li[data-evidence-id='F0.S0']")?.getAttribute("aria-current")).toBe("true");
  });

  it("a transcript citation seeks to its span without a box and marks the spoken line", async () => {
    await ask();
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Spoken citation T0 at 0:00\.3/u }));
    const video = document.querySelector("video") as HTMLVideoElement;
    expect(video.currentTime).toBeCloseTo(0.343, 3);
    expect(screen.queryByTestId("citation-box")).toBeNull();
    expect(document.querySelector("li[data-evidence-id='T0'][aria-current='true']")).not.toBeNull();
    // Moving to another citation moves the highlight and clears the previous current marker.
    fireEvent.click(screen.getByRole("button", { name: /On-screen text citation F0\.S0/u }));
    expect(document.querySelector("li[data-evidence-id='T0'][aria-current='true']")).toBeNull();
  });

  it("is keyboard operable: citations are native buttons reachable in order", async () => {
    await ask();
    const buttons = screen.getAllByRole("button").filter((b) => b.hasAttribute("data-evidence-id"));
    expect(buttons.map((b) => b.getAttribute("data-evidence-id"))).toEqual(["T0", "F0.S0", "F0"]);
    for (const b of buttons) expect(b.tagName).toBe("BUTTON");
  });

  it("an unverifiable source is refused: citations show evidence but cannot seek", async () => {
    const p = port({ readArtifactContent: vi.fn(() => Promise.resolve({ status: 200, contentType: "video/mp4", bytes: new TextEncoder().encode("tampered") })) as never });
    await ask(p);
    await screen.findByText(/cannot seek/u);
    expect(document.querySelector("video")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Spoken citation T0/u }));
    expect(screen.getByTestId("active-citation").textContent).toContain("source video not available to seek");
  });

  it("an unknown outcome shows no answer and retries with the same request identity", async () => {
    const calls: string[] = [];
    const p = port({ ask: vi.fn((request: { requestId: string }) => { calls.push(request.requestId);
      return calls.length === 1 ? Promise.reject(new DevGroundedHostError("OUTCOME_UNKNOWN", 0, "no response")) : Promise.resolve({ status: 201, body: body() }); }) as never });
    render(React.createElement(DevGroundedAnswerPanel, { answers: p as never }));
    fireEvent.change(screen.getByLabelText("Source video artifact ID"), { target: { value: "src-1" } });
    fireEvent.change(screen.getByLabelText(/Exact source version/u), { target: { value: `sha256:${SOURCE_SHA}` } });
    fireEvent.change(screen.getByLabelText(/Question about the video/u), { target: { value: "q?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask with citations" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("outcome is unknown");
    expect(screen.queryByRole("heading", { name: /Answer to/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask with citations" }));
    await screen.findByRole("heading", { name: /Answer to/u });
    expect(calls[1]).toBe(calls[0]);
  });

  it("a typed rights refusal is shown as denied and no answer is rendered", async () => {
    const p = port({ ask: vi.fn(() => Promise.reject(new DevGroundedHostError("RIGHTS_REVOKED", 403, "revoked"))) as never });
    render(React.createElement(DevGroundedAnswerPanel, { answers: p as never }));
    fireEvent.change(screen.getByLabelText("Source video artifact ID"), { target: { value: "src-1" } });
    fireEvent.change(screen.getByLabelText(/Exact source version/u), { target: { value: `sha256:${SOURCE_SHA}` } });
    fireEvent.change(screen.getByLabelText(/Question about the video/u), { target: { value: "q?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask with citations" }));
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-tone")).toBe("denied");
    expect(alert.textContent).toContain("RIGHTS_REVOKED");
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("rejects an inconsistent status and replay flag instead of presenting it", async () => {
    const p = port({ ask: vi.fn(() => Promise.resolve({ status: 200, body: body({ replayed: false }) })) as never });
    render(React.createElement(DevGroundedAnswerPanel, { answers: p as never }));
    fireEvent.change(screen.getByLabelText("Source video artifact ID"), { target: { value: "src-1" } });
    fireEvent.change(screen.getByLabelText(/Exact source version/u), { target: { value: `sha256:${SOURCE_SHA}` } });
    fireEvent.change(screen.getByLabelText(/Question about the video/u), { target: { value: "q?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask with citations" }));
    expect((await screen.findByRole("alert")).textContent).toContain("INVALID_RESPONSE");
  });

  it("reopens an answer by id and a locked panel sends nothing", async () => {
    const p = port();
    render(React.createElement(DevGroundedAnswerPanel, { answers: p as never }));
    fireEvent.change(screen.getByLabelText("Reopen answer by output ID"), { target: { value: "out-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await screen.findByRole("heading", { name: /Answer to/u });
    expect(document.querySelector("article")?.getAttribute("data-via")).toBe("reopened");
    cleanup();
    const locked = port();
    render(React.createElement(DevGroundedAnswerPanel, { answers: locked as never, locked: true }));
    expect((screen.getByRole("button", { name: "Ask with citations" }) as HTMLButtonElement).disabled).toBe(true);
    expect(locked.ask).not.toHaveBeenCalled();
  });
});
