// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactIntakeScreen } from "./ArtifactIntakeScreen";
import type { MediaActionPort, MediaContextPort, MediaDataPort } from "../ports";

const baseProps = {
  data: { currentProjection: { title: "Import media", description: "Select source files.", steps: [{ id: "select", title: "Select", description: "Choose files.", state: "current" as const }], currentStepId: "select" }, operationObservation: { state: "READY", progress: { kind: "none" as const } } } satisfies MediaDataPort,
  actions: [],
  actionPort: { invoke: vi.fn(async () => ({ status: "unavailable" as const, reason: "No action dispatched." })) } satisfies MediaActionPort,
  context: { locale: "en-US" } satisfies MediaContextPort,
  intake: { view: "import-media" as const },
};

describe("ArtifactIntakeScreen local source selection", () => {
  it("announces only a local file count without claiming transfer finality", () => {
    const onSourceFilesSelected = vi.fn();
    render(React.createElement(ArtifactIntakeScreen, { ...baseProps, onSourceFilesSelected }));

    const input = screen.getByLabelText("Choose source media") as HTMLInputElement;
    const files = [new File(["a"], "one.mp4"), new File(["b"], "two.wav")];
    fireEvent.change(input, { target: { files } });

    const announcement = screen.getByText("2 source files are selected locally.");
    expect(announcement.getAttribute("role")).toBe("status");
    expect(onSourceFilesSelected).toHaveBeenCalledWith(files);
  });

  it("reports a cleared local selection", () => {
    render(React.createElement(ArtifactIntakeScreen, baseProps));
    fireEvent.change(screen.getByLabelText("Choose source media"), { target: { files: [] } });
    const announcement = screen.getByText("No source files are selected locally.");
    expect(announcement.getAttribute("role")).toBe("status");
  });
});
