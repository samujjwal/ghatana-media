// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactInspectionScreen, type CanonicalArtifactReadClient } from "./ArtifactInspectionScreen";
import type { MediaActionPort, MediaContextPort, MediaDataPort } from "../ports";

const baseProps = {
  data: { currentProjection: { title: "Inspect media", description: "Read metadata.", steps: [{ id: "read", title: "Read", description: "Read metadata.", state: "current" as const }], currentStepId: "read" }, operationObservation: { state: "READY", progress: { kind: "none" as const } } } satisfies MediaDataPort,
  actions: [], actionPort: { invoke: vi.fn(async () => ({ status: "unavailable" as const, reason: "No action dispatched." })) } satisfies MediaActionPort,
  context: { locale: "en-US" } satisfies MediaContextPort,
  authenticatedHostContext: { tenantId: "tenant-1", principalId: "principal-1" },
  artifactId: "artifact-17",
};

const snapshot = (artifactId: string) => ({ tenantId: "tenant-1", principalId: "principal-1", artifactId, fileName: "clip.mp4", contentType: "video/mp4", sizeBytes: 128, sha256: "a".repeat(64), objectReference: "opaque-ref", classification: "INTERNAL" as const, createdAt: "2026-11-01T12:00:00Z", expiresAt: "2026-12-01T12:00:00Z", metadata: {} });

describe("ArtifactInspectionScreen canonical read", () => {
  it("shows only metadata from the exact authenticated read and keeps object reference opaque", async () => {
    const canonicalArtifactReadClient: CanonicalArtifactReadClient = { getArtifact: vi.fn(async (id) => snapshot(id)) };
    render(React.createElement(ArtifactInspectionScreen, { ...baseProps, canonicalArtifactReadClient }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh artifact metadata" }));
    expect(await screen.findByText("Metadata observed for artifact-17. This does not establish current availability or processing rights.")).toBeTruthy();
    expect(screen.getByText("opaque-ref").tagName).toBe("CODE");
    expect(screen.queryByRole("link")).toBeNull();
    expect(canonicalArtifactReadClient.getArtifact).toHaveBeenCalledWith("artifact-17", expect.any(AbortSignal));
  });

  it("distinguishes denial, caller-scoped absence, and unavailable or malformed observations", async () => {
    const denied: CanonicalArtifactReadClient = { getArtifact: vi.fn(async () => { throw Object.assign(new Error("not visible"), { statusCode: 404 }); }) };
    const { rerender } = render(React.createElement(ArtifactInspectionScreen, { ...baseProps, canonicalArtifactReadClient: denied }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh artifact metadata" }));
    expect(await screen.findByText("No artifact metadata is visible in this caller scope. This does not establish global absence.")).toBeTruthy();

    const forbidden: CanonicalArtifactReadClient = { getArtifact: vi.fn(async () => { throw Object.assign(new Error("denied"), { statusCode: 403 }); }) };
    rerender(React.createElement(ArtifactInspectionScreen, { ...baseProps, canonicalArtifactReadClient: forbidden }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh artifact metadata" }));
    expect(await screen.findByText("Artifact metadata access is denied for this caller.")).toBeTruthy();

    const unavailable: CanonicalArtifactReadClient = { getArtifact: vi.fn(async () => { throw new Error("unavailable"); }) };
    rerender(React.createElement(ArtifactInspectionScreen, { ...baseProps, canonicalArtifactReadClient: unavailable }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh artifact metadata" }));
    expect(await screen.findByText("Artifact metadata is unavailable or invalid. No availability or rights conclusion was made.")).toBeTruthy();
  });

  it("aborts stale reads on artifact change and labels an absent reader NOT_ADMITTED", () => {
    let signal: AbortSignal | undefined;
    const reader: CanonicalArtifactReadClient = { getArtifact: vi.fn((_id, requestSignal) => { signal = requestSignal; return new Promise<never>(() => undefined); }) };
    const { rerender } = render(React.createElement(ArtifactInspectionScreen, { ...baseProps, canonicalArtifactReadClient: reader }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh artifact metadata" }));
    rerender(React.createElement(ArtifactInspectionScreen, { ...baseProps, artifactId: "artifact-18", canonicalArtifactReadClient: reader }));
    expect(signal?.aborted).toBe(true);
    expect(screen.getByText("Artifact metadata has not been refreshed in this view.")).toBeTruthy();
    rerender(React.createElement(ArtifactInspectionScreen, baseProps));
    expect(screen.getByText("Canonical artifact inspection is NOT_ADMITTED. No live read was requested.")).toBeTruthy();
  });

  it("fails closed when the host reader returns metadata outside the bounded observation schema", async () => {
    const malformed = snapshot("artifact-17");
    const reader: CanonicalArtifactReadClient = { getArtifact: vi.fn(async () => ({
      ...malformed,
      sizeBytes: Number.MAX_SAFE_INTEGER + 1,
      objectReference: "",
      metadata: [] as unknown as Readonly<Record<string, unknown>>,
    })) };
    render(React.createElement(ArtifactInspectionScreen, { ...baseProps, canonicalArtifactReadClient: reader }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh artifact metadata" }));
    expect(await screen.findByText("Artifact metadata is unavailable or invalid. No availability or rights conclusion was made.")).toBeTruthy();
    expect(screen.queryByText("clip.mp4")).toBeNull();
    expect(screen.queryByText("opaque-ref")).toBeNull();
  });

  it("rejects a response outside the trusted host tenant or principal", async () => {
    const reader: CanonicalArtifactReadClient = { getArtifact: vi.fn(async () => ({
      ...snapshot("artifact-17"),
      tenantId: "tenant-other",
    })) };
    render(React.createElement(ArtifactInspectionScreen, { ...baseProps, canonicalArtifactReadClient: reader }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh artifact metadata" }));
    expect(await screen.findByText("Artifact metadata is unavailable or invalid. No availability or rights conclusion was made.")).toBeTruthy();
    expect(screen.queryByText("clip.mp4")).toBeNull();
    expect(screen.queryByText("opaque-ref")).toBeNull();
  });

  it("does not dispatch a reader without trusted host identity", () => {
    const reader: CanonicalArtifactReadClient = { getArtifact: vi.fn(async (id) => snapshot(id)) };
    render(React.createElement(ArtifactInspectionScreen, { ...baseProps, authenticatedHostContext: undefined,
      canonicalArtifactReadClient: reader }));
    expect(screen.getByText("Canonical artifact inspection is NOT_ADMITTED. No live read was requested.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Refresh artifact metadata" })).toBeNull();
    expect(reader.getArtifact).not.toHaveBeenCalled();
  });
});
