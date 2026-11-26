import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MediaTaskFlow } from "./MediaTaskFlow";

describe("MediaTaskFlow instance-scoped accessibility IDs", () => {
  it("keeps IDs unique and resolves label and description references with arbitrary host IDs", () => {
    const flow = (title: string): React.ReactElement => React.createElement(MediaTaskFlow, {
      title,
      description: "A workflow description.",
      steps: [{
        id: "process step",
        title: "Process",
        description: "Process the source.",
        state: "blocked",
        blockedReason: "Source authority is not verified.",
      }],
      currentStepId: "process step",
      operationObservation: {
        state: "OUTCOME_UNKNOWN",
        progress: { kind: "unknown" },
        message: "Check status before continuing.",
      },
      primaryAction: {
        id: "process action",
        label: "Start processing",
        onAction: vi.fn(),
        disabled: true,
        disabledReason: "The current source is not authorized.",
      },
      availableActions: [{
        id: "retry action",
        label: "Retry",
        onAction: vi.fn(),
        disabled: true,
        disabledReason: "Resolve the unknown outcome first.",
      }],
      children: React.createElement("p", null, "Workflow content"),
    });
    const html = renderToStaticMarkup(React.createElement(
      React.Fragment,
      null,
      flow("First workflow"),
      flow("Second workflow"),
    ));
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
    const uniqueIds = new Set(ids);
    const operationSections = [...html.matchAll(/<section class="media-task-operation-status" aria-labelledby="([^"]+)"/gu)]
      .map((match) => match[1]!);
    const operationHeadingIds = new Set([...html.matchAll(/<h2 id="([^"]*media-operation-title)">/gu)].map((match) => match[1]!));

    expect(uniqueIds.size).toBe(ids.length);
    expect(operationSections).toHaveLength(2);
    for (const label of operationSections) expect(operationHeadingIds).toContain(label);

    for (const attribute of ["aria-labelledby", "aria-describedby"] as const) {
      const references = [...html.matchAll(new RegExp(`${attribute}="([^"]+)"`, "gu"))]
        .flatMap((match) => match[1]!.split(/\s+/u));
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) expect(uniqueIds).toContain(reference);
    }
  });
});
