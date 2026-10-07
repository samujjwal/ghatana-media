import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MediaTaskScreen } from "./MediaTaskScreen";
import { MediaTaskFlow } from "../components/MediaTaskFlow";
import { JobRecoveryScreen } from "./JobRecoveryScreen";
import { MediaProductRenderer, type MediaProductRendererProps } from "./MediaProductRenderer";

const actionPort = { invoke: vi.fn(async () => ({ status: "request-acknowledged" as const, requestId: "request-1" })) };
const common = {
  data: {
    currentProjection: {
      title: "Check an export",
      description: "Observe the existing export job.",
      steps: [{ id: "observe", title: "Observe status", description: "Check the same job.", state: "current" as const }],
      currentStepId: "observe",
    },
    operationObservation: {
      state: "OUTCOME_UNKNOWN",
      progress: { kind: "unknown" as const, label: "The remote outcome is not known yet." },
      finality: "UNKNOWN",
    },
  },
  actions: [{ id: "media.action.check-job-outcome", label: "Check job outcome", enabled: true }],
  nextSafeActionIds: [] as readonly string[],
  actionPort,
  context: { locale: "en-US" },
};

describe("MediaProductRenderer", () => {
  it("renders the same public job screen with exact identity and unknown finality", () => {
    const props: MediaProductRendererProps = {
      kind: "job-recovery",
      ...common,
      job: { jobId: "media-job-42", observedAt: "sequence 7", finality: "UNKNOWN" },
    };
    const element = MediaProductRenderer(props);

    expect(element.type).toBe(JobRecoveryScreen);
    const html = renderToStaticMarkup(React.createElement(MediaProductRenderer, props));
    expect(html).toContain("media-job-42");
    expect(html).toContain("The remote outcome is not known yet.");
    expect(html).toContain("UNKNOWN");
    expect(html).toContain("Check job outcome");
  });

  it("forwards the typed action port and data projection to the screen action", () => {
    actionPort.invoke.mockClear();
    const props: MediaProductRendererProps = {
      kind: "job-recovery",
      ...common,
      job: { jobId: "media-job-42", finality: "UNKNOWN" },
    };
    const screenElement = MediaProductRenderer(props);
    const screen = (screenElement.type as typeof JobRecoveryScreen)(screenElement.props as never);
    expect(screen.type).toBe(MediaTaskScreen);
    const screenTree = (screen.type as typeof MediaTaskScreen)(screen.props as never);
    const flowElement = (screenTree.props as { children: React.ReactElement }).children;
    expect(flowElement.type).toBe(MediaTaskFlow);
    const flowProps = flowElement.props as {
      currentProjection: typeof common.data.currentProjection;
      operationObservation: typeof common.data.operationObservation;
      availableActions: readonly { id: string; onAction: () => void }[];
    };

    expect(flowProps.currentProjection).toBe(common.data.currentProjection);
    expect(flowProps.operationObservation).toBe(common.data.operationObservation);
    flowProps.availableActions[0]!.onAction();
    expect(actionPort.invoke).toHaveBeenCalledWith("media.action.check-job-outcome");
  });
});
