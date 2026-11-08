// @vitest-environment jsdom

import React from "react";
import type { CaptionVersionRegistered, CaptionVersionTransport } from "@audio-video/client/caption-version";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptCaptionScreen, type TranscriptCaptionProjection } from "./TranscriptCaptionScreen";

// Isolate the screen body from Shared design-system package installation in
// this workspace; these tests exercise only the caption read capability.
vi.mock("./MediaTaskScreen", () => ({
  MediaTaskScreen: ({ children }: { readonly children: React.ReactNode }) => children,
}));

afterEach(cleanup);

const row = (sourceArtifactVersionId: string, captionVersionId = "caption-version-1"): CaptionVersionRegistered => ({
  requestId: "caption-request-1",
  requestFingerprint: "a".repeat(64),
  captionVersionId,
  registrationReceiptId: "caption-receipt-1",
  sourceArtifactId: "artifact-1",
  sourceArtifactVersionId,
  parentVersionKind: "TRANSCRIPT_VERSION" as const,
  parentVersionId: "transcript-version-1",
  languageDisposition: "DECLARED_BY_USER" as const,
  sourceClockId: "source-clock-1",
  registeredAt: 1_800_000_000_000,
});

function props(transcript: TranscriptCaptionProjection, versions: CaptionVersionTransport["versions"]) {
  return {
    data: {
      currentProjection: {
        title: "Compare caption versions",
        description: "Compare versions on one source.",
        steps: [{ id: "compare", title: "Compare", description: "Select versions.", state: "current" as const }],
        currentStepId: "compare",
      },
    },
    context: { locale: "en-US" },
    transcript,
    canonicalCaptionVersionReader: {
      runtimeAdmission: "ADMITTED" as const,
      tenantId: "tenant-1",
      principalId: "principal-1",
      sourceArtifactId: transcript.sourceArtifactId ?? "artifact-1",
      sourceArtifactVersionId: transcript.sourceArtifactVersionId ?? "artifact-version-2",
      transport: { versions: vi.fn(versions) },
    },
  };
}

function projection(sourceArtifactVersionId = "artifact-version-2"): TranscriptCaptionProjection {
  return {
    view: "compare-caption-versions",
    sourceArtifactId: "artifact-1",
    sourceArtifactVersionId,
    sourceArtifactVersion: `artifact-1@${sourceArtifactVersionId}`,
    versions: [{ id: "host-stale-version", label: "Stale host label" }],
  };
}

describe("canonical caption version listing", () => {
  it("replaces host-projected choices only after exact source-version readback", async () => {
    const readVersions = vi.fn(async () => [row("artifact-version-2")]);
    render(React.createElement(TranscriptCaptionScreen, props(projection(), readVersions)));

    expect(await screen.findByText("caption-version-1", { selector: "code" })).toBeTruthy();
    expect(screen.queryByText("host-stale-version")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/1 canonical caption version/);
    expect(readVersions).toHaveBeenCalledWith("tenant-1", "principal-1", "artifact-1", "artifact-version-2");
  });

  it("hides projected versions after denial", async () => {
    const readVersions = vi.fn(async () => { throw Object.assign(new Error("private detail"), { status: 403 }); });
    render(React.createElement(TranscriptCaptionScreen, props(projection(), readVersions)));

    expect(await screen.findByText(/read was denied/)).toBeTruthy();
    expect(screen.queryByText("host-stale-version")).toBeNull();
    expect(screen.queryByText("private detail")).toBeNull();
  });

  it("refreshes only through the injected canonical reader on explicit user action", async () => {
    const readVersions = vi.fn()
      .mockResolvedValueOnce([row("artifact-version-2", "caption-version-old")])
      .mockResolvedValueOnce([row("artifact-version-2", "caption-version-new")]);
    render(React.createElement(TranscriptCaptionScreen, props(projection(), readVersions)));
    expect(await screen.findByText("caption-version-old", { selector: "code" })).toBeTruthy();

    screen.getByRole("button", { name: "Refresh canonical versions" }).click();
    expect(await screen.findByText("caption-version-new", { selector: "code" })).toBeTruthy();
    expect(screen.queryByText("caption-version-old", { selector: "code" })).toBeNull();
    expect(readVersions).toHaveBeenCalledTimes(2);
  });

  it("rejects the complete response when any row crosses the exact source-version scope", async () => {
    const readVersions = vi.fn(async () => [row("artifact-version-other")]);
    render(React.createElement(TranscriptCaptionScreen, props(projection(), readVersions)));

    expect(await screen.findByText(/list is unknown/)).toBeTruthy();
    expect(screen.queryByText("caption-version-1")).toBeNull();
    expect(screen.queryByText("host-stale-version")).toBeNull();
  });

  it("hides previously observed rows when the capability no longer matches the displayed source", async () => {
    const readVersions = vi.fn(async () => [row("artifact-version-2")]);
    const screenProps = props(projection(), readVersions);
    const view = render(React.createElement(TranscriptCaptionScreen, screenProps));
    expect(await screen.findByText("caption-version-1", { selector: "code" })).toBeTruthy();
    view.rerender(React.createElement(TranscriptCaptionScreen, {
      ...screenProps,
      transcript: projection("artifact-version-3"),
    }));

    expect(await screen.findByText(/reader scope does not match/)).toBeTruthy();
    expect(screen.getByRole("status").getAttribute("data-state")).toBe("unknown");
    expect(readVersions).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("caption-version-1", { selector: "code" })).toBeNull();
    expect(screen.queryByText("host-stale-version")).toBeNull();
  });

  it("discards an older source-version response after the projection changes", async () => {
    let finishOld!: (versions: readonly CaptionVersionRegistered[]) => void;
    const readVersions = vi.fn((_: string, __: string, ___: string, sourceVersionId: string) => {
      if (sourceVersionId === "artifact-version-2") {
        return new Promise<readonly unknown[]>((resolve) => { finishOld = resolve; });
      }
      return Promise.resolve([row("artifact-version-3", "caption-version-current")]);
    });
    const readerProps = props(projection(), readVersions);
    const view = render(React.createElement(TranscriptCaptionScreen, readerProps));
    view.rerender(React.createElement(TranscriptCaptionScreen, {
      ...readerProps,
      transcript: projection("artifact-version-3"),
    }));
    expect(await screen.findByText("caption-version-current", { selector: "code" })).toBeTruthy();

    finishOld([row("artifact-version-2", "caption-version-stale")]);
    await waitFor(() => expect(screen.queryByText("caption-version-stale")).toBeNull());
    expect(screen.getByText("caption-version-current", { selector: "code" })).toBeTruthy();
  });
});
