// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceSynthesisPanel } from "./VoiceSynthesisPanel";
import {
  DevVoiceHostError, describeVoiceFailure, parseVoiceCapabilities, parseVoiceSynthesisView,
  type DevVoiceHostResponse, type DevVoiceSynthesisPort,
} from "./devVoiceSynthesis";

afterEach(cleanup);

const SHA = "b".repeat(64);
const capabilitiesBody = (over: Record<string, unknown> = {}): unknown => ({
  scope: "DEV_ONLY",
  speechToText: { ready: false, installState: "NOT_CONFIGURED" },
  textToSpeech: {
    ready: true, installState: "VERIFIED", modelId: "hexgrad/Kokoro-82M", revision: "f3ff357", licenseSpdx: "Apache-2.0",
    verifiedLanguages: ["en"], voices: ["af_heart", "am_michael"], defaultVoice: "af_heart", voiceCloning: "NOT_SUPPORTED",
    maxTextChars: 2000, attribution: { noticeRequired: true, notice: "Kokoro-82M (c) hexgrad, Apache-2.0 attribution notice." },
    ...over,
  },
});
const synthBody = (over: { replayed?: boolean; durationMillis?: number } = {}): unknown => ({
  schema: "media.dev.speech-output.v1", scope: "DEV_ONLY", outputId: "art-1", replayed: over.replayed ?? false,
  note: "DEV_ONLY synthesized speech",
  artifact: { artifactId: "art-1", artifactVersionId: `sha256:${SHA}`, contentType: "audio/wav", sizeBytes: 100000, sha256: SHA },
  lineage: { kind: "LOCAL_TTS_AUDIO", requestId: "voice-fixed", voice: "am_michael", locale: "en",
    audio: { sampleRate: 24000, channels: 1, bitsPerSample: 16, durationMillis: over.durationMillis ?? 2500, voiceCloning: "NOT_SUPPORTED" } },
});
const ok = (status: number, body: unknown): Promise<DevVoiceHostResponse> => Promise.resolve({ status, body });
type FakePort = { [K in keyof DevVoiceSynthesisPort]-?: ReturnType<typeof vi.fn> };
function fakePort(over: Partial<DevVoiceSynthesisPort> = {}, caps: unknown = capabilitiesBody()): FakePort {
  return {
    getCapabilities: vi.fn(() => ok(200, caps)),
    synthesize: vi.fn(() => ok(201, synthBody())),
    readArtifactContent: undefined,
    addToTimeline: undefined,
    ...over,
  } as unknown as FakePort;
}
const asPort = (port: FakePort): DevVoiceSynthesisPort => port as unknown as DevVoiceSynthesisPort;
const ids = (): (() => string) => { let n = 0; return () => `voice-req-${++n}`; };

async function mounted(port: FakePort, locked = false) {
  render(React.createElement(VoiceSynthesisPanel, { voice: asPort(port), locked, newRequestId: ids() }));
  await waitFor(() => expect(screen.getByLabelText("Voice")).toBeTruthy());
  await waitFor(() => expect((screen.getByLabelText("Voice") as HTMLSelectElement).options.length).toBeGreaterThan(0));
}
const type = (text: string) => fireEvent.change(screen.getByLabelText("Text to speak"), { target: { value: text } });
const options = (label: string) => Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((o) => o.value);

describe("VoiceSynthesisPanel", () => {
  it("lists only the voices and locales the host reports and shows the licence and attribution notice", async () => {
    const port = fakePort({}, capabilitiesBody({ voices: ["af_heart", "am_michael"], verifiedLanguages: ["en", "xx"] }));
    await mounted(port);
    expect(options("Voice")).toEqual(["af_heart", "am_michael"]);
    expect(options("Locale")).toEqual(["en", "xx"]);
    const licence = document.querySelector("[data-voice-licence]")!;
    expect(licence.textContent).toContain("Apache-2.0");
    expect(licence.textContent).toContain("Kokoro-82M (c) hexgrad, Apache-2.0 attribution notice.");
    expect(licence.textContent).toContain("not supported");
    expect(port.getCapabilities).toHaveBeenCalledTimes(1);
  });

  it("follows the selected locale when the host reports a voice-language map", async () => {
    const port = fakePort({}, capabilitiesBody({ voices: ["af_heart", "am_michael", "ef_dora", "em_alex"], verifiedLanguages: ["en", "es"],
      voiceLanguages: { af_heart: "en", am_michael: "en", ef_dora: "es", em_alex: "es" } }));
    await mounted(port);
    expect(options("Locale")).toEqual(["en", "es"]);
    expect(options("Voice")).toEqual(["af_heart", "am_michael"]);
    fireEvent.change(screen.getByLabelText("Locale"), { target: { value: "es" } });
    expect(options("Voice")).toEqual(["ef_dora", "em_alex"]);
    expect((screen.getByLabelText("Voice") as HTMLSelectElement).value).toBe("ef_dora");
    type("Hola.");
    fireEvent.click(screen.getByRole("button", { name: "Synthesize" }));
    await waitFor(() => expect(port.synthesize).toHaveBeenCalled());
    expect(port.synthesize).toHaveBeenCalledWith(expect.objectContaining({ voice: "ef_dora", locale: "es" }));
    expect(describeVoiceFailure(new DevVoiceHostError("VOICE_LOCALE_MISMATCH", 422, "x")).text).toContain("does not speak");
  });

  it("offers a different voice set when the host reports different voices (nothing is hard-coded)", async () => {
    await mounted(fakePort({}, capabilitiesBody({ voices: ["zz_test"], defaultVoice: "zz_test", verifiedLanguages: ["ne"] })));
    expect(options("Voice")).toEqual(["zz_test"]);
    expect(options("Locale")).toEqual(["ne"]);
    expect(document.body.textContent).not.toContain("af_heart");
  });

  it("fails closed and disables the form when the model is not ready or capabilities are unreadable", async () => {
    render(React.createElement(VoiceSynthesisPanel, { voice: asPort(fakePort({}, capabilitiesBody({ ready: false, installState: "REJECTED", voices: [], verifiedLanguages: [] }))) }));
    await waitFor(() => expect(document.querySelector("[data-capabilities-status]")!.textContent).toContain("not available"));
    expect(screen.getByRole("button", { name: "Synthesize" }).hasAttribute("disabled")).toBe(true);
    expect(document.querySelector("[data-capabilities-status]")!.textContent).toContain("not available");
    cleanup();
    const broken = fakePort({ getCapabilities: vi.fn(() => Promise.reject(new DevVoiceHostError("HTTP_ERROR", 503, "down"))) });
    render(React.createElement(VoiceSynthesisPanel, { voice: asPort(broken) }));
    await waitFor(() => expect(screen.getByText(/HTTP_ERROR/u)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Retry reading capabilities" })).toBeTruthy();
  });

  it("validates input before any request and moves focus to the text field", async () => {
    const port = fakePort();
    await mounted(port);
    fireEvent.click(screen.getByRole("button", { name: "Synthesize" }));
    expect(screen.getByRole("alert").textContent).toContain("Enter the text to speak.");
    expect(document.activeElement).toBe(screen.getByLabelText("Text to speak"));
    expect(port.synthesize).not.toHaveBeenCalled();
    type("hello");
    fireEvent.change(screen.getByLabelText(/Speaking rate/u), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Synthesize" }));
    expect(screen.getByRole("alert").textContent).toContain("Speaking rate");
    expect(port.synthesize).not.toHaveBeenCalled();
  });

  it("synthesizes the selected voice and locale, shows the typed result and verified playback controls", async () => {
    const read = vi.fn(async () => ({ status: 200, contentType: "audio/wav", bytes: new Uint8Array([1, 2, 3]) }));
    const port = fakePort({ readArtifactContent: read });
    await mounted(port);
    fireEvent.change(screen.getByLabelText("Voice"), { target: { value: "am_michael" } });
    type("The quick brown fox.");
    fireEvent.click(screen.getByRole("button", { name: "Synthesize" }));
    await waitFor(() => expect(document.querySelector("[data-synthesis-result]")).toBeTruthy());
    // This fake-host DEV_ONLY response checks the local focus transition, not real synthesis or playback qualification.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Synthesized clip" })));
    expect(port.synthesize).toHaveBeenCalledWith({ requestId: "voice-req-1", text: "The quick brown fox.", voice: "am_michael", locale: "en", speakingRate: 1 });
    expect(document.querySelector("[data-result-voice]")!.textContent).toBe("am_michael");
    expect(document.querySelector("[data-result-duration]")!.textContent).toBe("2.50 s");
    expect(screen.getByRole("button", { name: /Preview WAV/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download WAV/u })).toBeTruthy();
    // Preview verifies the SHA-256 first: wrong bytes are refused and never played.
    fireEvent.click(screen.getByRole("button", { name: /Preview WAV/u }));
    await waitFor(() => expect(document.querySelector('[data-content-state="failed"]')).toBeTruthy());
    expect(document.querySelector("[data-verified-preview]")).toBeNull();
  });

  it("reuses the same request identifier for an unchanged retry after an unknown outcome", async () => {
    const synthesize = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new DevVoiceHostError("SPEECH_OUTCOME_UNKNOWN", 503, "ended")))
      .mockImplementationOnce(() => ok(201, synthBody()));
    const port = fakePort({ synthesize });
    await mounted(port);
    type("Retry me.");
    fireEvent.click(screen.getByRole("button", { name: "Synthesize" }));
    await waitFor(() => expect(document.querySelector('[data-failure-tone="unknown"]')).toBeTruthy());
    expect(document.querySelector("[data-synthesis-result]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Synthesize" }));
    await waitFor(() => expect(document.querySelector("[data-synthesis-result]")).toBeTruthy());
    expect(synthesize.mock.calls[0]![0].requestId).toBe(synthesize.mock.calls[1]![0].requestId);
    // Changing the text is a different request.
    type("Another sentence.");
    fireEvent.click(screen.getByRole("button", { name: "Synthesize" }));
    await waitFor(() => expect(synthesize).toHaveBeenCalledTimes(3));
    expect(synthesize.mock.calls[2]![0].requestId).not.toBe(synthesize.mock.calls[0]![0].requestId);
  });

  it.each([
    ["LOCALE_NOT_ADMITTED", 422, "denied", /not verified/u],
    ["VOICE_NOT_ADMITTED", 422, "denied", /not part of the verified model/u],
    ["VOICE_CLONING_NOT_SUPPORTED", 422, "unsupported", /not supported/u],
    ["RIGHTS_DECISION_REVOKED", 403, "denied", /revoked/u],
    ["RIGHTS_AUTHORITY_UNAVAILABLE", 422, "unavailable", /No rights and consent authority/u],
  ])("shows %s as a typed refusal and no result", async (code, status, tone, message) => {
    const port = fakePort({ synthesize: vi.fn(() => Promise.reject(new DevVoiceHostError(code, status, code))) });
    await mounted(port);
    type("Refuse me.");
    fireEvent.click(screen.getByRole("button", { name: "Synthesize" }));
    await waitFor(() => expect(document.querySelector(`[data-failure-code="${code}"]`)).toBeTruthy());
    const alert = document.querySelector(`[data-failure-code="${code}"]`)!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.getAttribute("data-failure-tone")).toBe(tone);
    expect(alert.textContent).toMatch(message);
    expect(document.querySelector("[data-synthesis-result]")).toBeNull();
  });

  it("rejects a malformed or non-audio synthesis response instead of showing a result", async () => {
    const port = fakePort({ synthesize: vi.fn(() => ok(201, { scope: "DEV_ONLY", artifact: {}, lineage: {} })) });
    await mounted(port);
    type("Bad body.");
    fireEvent.click(screen.getByRole("button", { name: "Synthesize" }));
    await waitFor(() => expect(document.querySelector('[data-failure-code="INVALID_RESPONSE"]')).toBeTruthy());
    expect(document.querySelector("[data-synthesis-result]")).toBeNull();
  });

  it("adds the exact synthesized version to the timeline with a stable clip id, and reports a host without a timeline", async () => {
    const addToTimeline = vi.fn(async (request: { clipId: string }) => ({
      projectId: "proj-1", timelineId: "timeline-main", revisionId: "rev-2", clipId: request.clipId, trackId: "audio-voice",
    }));
    const port = fakePort({ addToTimeline });
    await mounted(port);
    type("Timeline me.");
    fireEvent.click(screen.getByRole("button", { name: "Synthesize" }));
    await waitFor(() => expect(document.querySelector("[data-synthesis-result]")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add to timeline" }));
    await waitFor(() => expect(document.querySelector('[data-timeline-status="placed"]')).toBeTruthy());
    expect(addToTimeline).toHaveBeenCalledWith({
      clipId: "voice-voice-req-1", artifactId: "art-1", artifactVersionId: `sha256:${SHA}`, sha256: SHA,
      durationMillis: 2500, sampleRate: 24000,
    });
    expect(document.querySelector("[data-timeline-status]")!.textContent).toContain("proj-1");
    cleanup();
    const noTimeline = fakePort();
    await mounted(noTimeline);
    type("No timeline.");
    fireEvent.click(screen.getByRole("button", { name: "Synthesize" }));
    await waitFor(() => expect(document.querySelector("[data-synthesis-result]")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Add to timeline" }).hasAttribute("disabled")).toBe(true);
    expect(document.querySelector("[data-timeline-status]")!.textContent).toContain("no project timeline");
  });

  it("is operable by keyboard order and exposes named controls, live regions and a labelled region", async () => {
    await mounted(fakePort());
    const region = screen.getByRole("region", { name: "Voice synthesis" });
    for (const name of ["Voice", "Locale", "Text to speak", /Speaking rate/u]) {
      const control = within(region).getByLabelText(name);
      expect(control.getAttribute("id")).toBeTruthy();
      expect((control as HTMLElement).tabIndex).toBeGreaterThanOrEqual(0);
    }
    expect(region.querySelectorAll('[aria-live="polite"]').length).toBeGreaterThanOrEqual(2);
    // Submission works from the keyboard-reachable form (Enter submits a native form).
    expect(screen.getByRole("button", { name: "Synthesize" }).getAttribute("type")).toBe("submit");
    // No control relies on a click handler on a non-interactive element.
    expect(region.querySelectorAll("[onclick]").length).toBe(0);
  });

  it("locks every control while the host is locked", async () => {
    await mounted(fakePort(), true);
    for (const name of ["Voice", "Locale", "Text to speak"]) expect((screen.getByLabelText(name) as HTMLElement).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Synthesize" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("devVoiceSynthesis parsing", () => {
  it("requires a DEV_ONLY text-to-speech section", () => {
    expect(() => parseVoiceCapabilities({ scope: "DEV_ONLY" })).toThrow(DevVoiceHostError);
    expect(() => parseVoiceCapabilities({ scope: "PROD", textToSpeech: { ready: true } })).toThrow(DevVoiceHostError);
    expect(parseVoiceCapabilities(capabilitiesBody()).voices).toEqual(["af_heart", "am_michael"]);
  });

  it("accepts only a self-consistent LOCAL_TTS_AUDIO view with positive duration", () => {
    expect(parseVoiceSynthesisView({ status: 201, body: synthBody() }).durationMillis).toBe(2500);
    expect(() => parseVoiceSynthesisView({ status: 201, body: synthBody({ durationMillis: 0 }) })).toThrow(DevVoiceHostError);
    const mismatched = synthBody() as { artifact: { artifactVersionId: string } };
    mismatched.artifact.artifactVersionId = `sha256:${"c".repeat(64)}`;
    expect(() => parseVoiceSynthesisView({ status: 201, body: mismatched })).toThrow(DevVoiceHostError);
  });

  it("describes an unobserved outcome as unknown, never as success", () => {
    expect(describeVoiceFailure(new DevVoiceHostError("OUTCOME_UNKNOWN", 0, "x")).tone).toBe("unknown");
    expect(describeVoiceFailure(new DevVoiceHostError("SPEECH_OUTCOME_UNKNOWN", 503, "x")).text).toContain("same request identifier");
  });
});
