// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevProviderStatusPanel } from "./DevProviderStatusPanel";
import {
  DevProviderCatalogHostError, describeDevProviderFailure, describeDevProviderReason, diffDevProviderStates,
  parseDevProviderCatalog, parseDevProviderEntry, shortDigest, type DevProviderCatalogPort,
} from "./devProviderCatalog";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  providerId: "whisper", kind: "SPEECH_TO_TEXT", state: "READY", reason: "VERIFIED_AND_PROBED",
  modelId: "openai/whisper-large-v3-turbo", revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
  license: { spdx: "MIT", noticeRequired: true, notice: "Whisper weights (c) OpenAI, MIT." },
  digests: { weightsSha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69" },
  verifiedLanguages: ["en"], voices: [],
  device: { kind: "UNREPORTED", reported: false, name: "" },
  productionEligible: false, fallback: "NONE", lastCheckedAt: "2026-11-14T12:00:00Z", probeMillis: 12, ...over,
});
const catalog = (providers: unknown[] = [row()]): unknown => ({
  schema: "media.dev.provider-catalog.v1", scope: "DEV_ONLY", checkedAt: "2026-11-14T12:00:00Z", cacheTtlSeconds: 5,
  productionEligible: false, fallbackPolicy: "NONE: Media never substitutes a different model", providers,
});
const port = (get: DevProviderCatalogPort["get"]): DevProviderCatalogPort => ({ get });

describe("parseDevProviderCatalog", () => {
  it("parses the host shape and keeps productionEligible false unless the host says true", () => {
    const view = parseDevProviderCatalog(catalog([row(), row({ providerId: "kokoro", state: "UNAVAILABLE", reason: "WORKER_NOT_RUNNING", productionEligible: "yes" })]));
    expect(view.providers.map((p) => p.state)).toEqual(["READY", "UNAVAILABLE"]);
    expect(view.providers[1]!.productionEligible).toBe(false);
    expect(view.providers[0]!.licenseSpdx).toBe("MIT");
    expect(view.providers[0]!.deviceReported).toBe(false);
  });

  it("refuses an unknown state, a wrong schema, duplicates and oversize fields instead of guessing READY", () => {
    expect(() => parseDevProviderEntry(row({ state: "HEALTHY" }))).toThrow(/state/u);
    expect(() => parseDevProviderEntry(row({ state: "ready" }))).toThrow();
    expect(() => parseDevProviderCatalog({ ...(catalog() as object), schema: "other" })).toThrow(/DEV_ONLY/u);
    expect(() => parseDevProviderCatalog({ ...(catalog() as object), scope: "PRODUCTION" })).toThrow();
    expect(() => parseDevProviderCatalog(catalog([row(), row()]))).toThrow(/duplicate/u);
    expect(() => parseDevProviderEntry(row({ reason: "x".repeat(500) }))).toThrow();
    expect(() => parseDevProviderCatalog(null)).toThrow();
  });

  it("diffs states between views and ignores new providers", () => {
    const a = parseDevProviderCatalog(catalog([row(), row({ providerId: "kokoro" })]));
    const b = parseDevProviderCatalog(catalog([row({ state: "WITHDRAWN" }), row({ providerId: "kokoro" }), row({ providerId: "qwen" })]));
    expect(diffDevProviderStates(a, b)).toEqual([{ providerId: "whisper", from: "READY", to: "WITHDRAWN" }]);
    expect(diffDevProviderStates(null, b)).toEqual([]);
  });

  it("explains known reasons and tolerates unknown ones", () => {
    expect(describeDevProviderReason("SIDECAR_UNREACHABLE")).toMatch(/port is closed/u);
    expect(describeDevProviderReason("SOMETHING_NEW")).toBe("See the reason code.");
    expect(shortDigest("a".repeat(64))).toBe(`${"a".repeat(12)}…`);
    expect(describeDevProviderFailure(new DevProviderCatalogHostError("INVALID_RESPONSE", 200, "x")).text).toMatch(/nothing is shown as ready/u);
  });
});

describe("DevProviderStatusPanel", () => {
  it("shows state as text with reason, licence and device, and never shows production eligibility as yes", async () => {
    const get = vi.fn(() => Promise.resolve({ status: 200, body: catalog([
      row({ device: { kind: "GPU", reported: true, name: "Quadro RTX 5000" } }),
      row({ providerId: "kokoro", kind: "TEXT_TO_SPEECH", state: "UNAVAILABLE", reason: "WORKER_NOT_RUNNING", voices: ["af_heart"], license: { spdx: "Apache-2.0", noticeRequired: true, notice: "Kokoro (c) hexgrad" } }),
      row({ providerId: "florence", state: "NOT_ADMITTED", reason: "MODEL_DIGEST_MISMATCH" }),
      row({ providerId: "qwen", state: "WITHDRAWN", reason: "MODEL_FILES_CHANGED" }),
      row({ providerId: "ffmpeg", state: "DEGRADED", reason: "PROBE_SLOW" }),
    ]) }));
    render(React.createElement(DevProviderStatusPanel, { catalog: port(get), live: false }));
    const table = await screen.findByRole("table", { name: "Local provider readiness" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.getAttribute("data-state"))).toEqual(["READY", "UNAVAILABLE", "NOT_ADMITTED", "WITHDRAWN", "DEGRADED"]);
    const whisper = rows[0]!;
    expect(within(whisper).getByText("READY")).toBeTruthy();
    expect(whisper.textContent).toContain("MIT");
    expect(whisper.textContent).toContain("GPU · Quadro RTX 5000");
    expect(rows[1]!.textContent).toContain("WORKER_NOT_RUNNING");
    expect(rows[1]!.textContent).toContain("not reported");
    expect(screen.getAllByText("No").length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByText("Yes")).toBeNull();
    expect(screen.getByRole("note").textContent).toMatch(/never substitutes a different model/u);
  });

  it("is keyboard accessible: labelled region, labelled controls, disclosure per provider", async () => {
    render(React.createElement(DevProviderStatusPanel, { catalog: port(() => Promise.resolve({ status: 200, body: catalog() })), live: false }));
    await screen.findByRole("table");
    expect(screen.getByRole("region", { name: /Local providers/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh now" })).toBeTruthy();
    const live = screen.getByLabelText("Live refresh") as HTMLInputElement;
    expect(live.checked).toBe(false);
    expect(document.querySelectorAll("details").length).toBe(1);
    expect(document.querySelector("[style]")).toBeNull();
  });

  it("refreshes live on the interval, announces state changes and stops when live is turned off", async () => {
    vi.useFakeTimers();
    let state = "READY";
    const get = vi.fn(() => Promise.resolve({ status: 200, body: catalog([row({ state, reason: state === "READY" ? "VERIFIED_AND_PROBED" : "WORKER_NOT_RUNNING" })]) }));
    render(React.createElement(DevProviderStatusPanel, { catalog: port(get), refreshIntervalMs: 1000 }));
    await act(async () => { await Promise.resolve(); });
    expect(get).toHaveBeenCalledTimes(1);
    state = "UNAVAILABLE";
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("provider-announcement").textContent).toBe("Whisper speech-to-text changed from READY to UNAVAILABLE.");
    expect(document.querySelector("tr[data-provider-id=whisper]")!.getAttribute("data-state")).toBe("UNAVAILABLE");
    fireEvent.click(screen.getByLabelText("Live refresh"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("keeps the last view but marks it stale when a refresh fails, and shows an unreadable catalog as not ready", async () => {
    let fail = false;
    const get = vi.fn(() => fail
      ? Promise.reject(new DevProviderCatalogHostError("TRANSPORT_ERROR", 0, "no answer"))
      : Promise.resolve({ status: 200, body: catalog() }));
    render(React.createElement(DevProviderStatusPanel, { catalog: port(get), live: false }));
    await screen.findByRole("table");
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/TRANSPORT_ERROR/u);
    expect(alert.textContent).toMatch(/stale/u);
    expect(document.querySelector(".dev-provider-status")!.getAttribute("data-stale")).toBe("true");

    cleanup();
    render(React.createElement(DevProviderStatusPanel, { catalog: port(() => Promise.resolve({ status: 200, body: catalog([row({ state: "HEALTHY" })]) })), live: false }));
    const bad = await screen.findByRole("alert");
    expect(bad.textContent).toMatch(/INVALID_RESPONSE/u);
    expect(screen.queryByRole("table")).toBeNull();
    await waitFor(() => expect(screen.queryByText("READY")).toBeNull());
  });

  it("does not start a second request while one is in flight", async () => {
    let release: (() => void) | undefined;
    const get = vi.fn(() => new Promise<{ status: number; body: unknown }>((resolve) => { release = () => resolve({ status: 200, body: catalog() }); }));
    render(React.createElement(DevProviderStatusPanel, { catalog: port(get), live: false }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect((screen.getByRole("button", { name: "Refresh now" }) as HTMLButtonElement).disabled).toBe(true);
    release!();
    await screen.findByRole("table");
    expect(get).toHaveBeenCalledTimes(1);
  });
});
