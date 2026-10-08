import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MediaTaskScreen } from "./MediaTaskScreen";
import { MediaTaskFlow } from "../components/MediaTaskFlow";
import { ArtifactIntakeScreen } from "./ArtifactIntakeScreen";
import { FirstUseProjectScreen } from "./FirstUseProjectScreen";
import { JobRecoveryScreen } from "./JobRecoveryScreen";
import { TranscriptCaptionScreen } from "./TranscriptCaptionScreen";
import {
  MediaProductRenderer,
  type MediaActionPort,
  type MediaContextPort,
  type MediaDataPort,
  type MediaNavigationPort,
  type MediaProductRendererProps,
  type MediaScreenAction,
} from "../index";

const actionPort = { invoke: vi.fn(async () => ({ status: "request-acknowledged" as const, requestId: "request-1" })) } satisfies MediaActionPort;
const navigationPort: MediaNavigationPort = { selectStep: vi.fn(), navigate: vi.fn() };
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
  actions: [{ id: "media.action.check-job-outcome", label: "Check job outcome", enabled: true }] satisfies readonly MediaScreenAction[],
  nextSafeActionIds: [] as readonly string[],
  actionPort,
  navigationPort,
  context: { locale: "en-US" } satisfies MediaContextPort,
} satisfies { data: MediaDataPort; actions: readonly MediaScreenAction[]; nextSafeActionIds: readonly string[]; actionPort: MediaActionPort; navigationPort: MediaNavigationPort; context: MediaContextPort };

describe("MediaProductRenderer", () => {
  it.each([
    {
      name: "first-use/project",
      props: {
        kind: "first-use-project",
        ...common,
        project: { view: "find-projects", accessState: "resolved", projects: [] },
      } satisfies MediaProductRendererProps,
      component: FirstUseProjectScreen,
      projectionKey: "project",
      projection: { view: "find-projects", accessState: "resolved", projects: [] },
    },
    {
      name: "artifact intake",
      props: {
        kind: "artifact-intake",
        ...common,
        intake: { view: "inspect-media", artifacts: [{ id: "artifact-7", name: "source.mov", version: "v3" }] },
      } satisfies MediaProductRendererProps,
      component: ArtifactIntakeScreen,
      projectionKey: "intake",
      projection: { view: "inspect-media", artifacts: [{ id: "artifact-7", name: "source.mov", version: "v3" }] },
    },
    {
      name: "job recovery",
      props: {
        kind: "job-recovery",
        ...common,
        job: { jobId: "media-job-42", finality: "UNKNOWN" },
      } satisfies MediaProductRendererProps,
      component: JobRecoveryScreen,
      projectionKey: "job",
      projection: { jobId: "media-job-42", finality: "UNKNOWN" },
    },
    {
      name: "transcript/caption",
      props: {
        kind: "transcript-caption",
        ...common,
        transcript: {
          view: "review-transcript",
          sourceArtifactVersion: "source-v5",
          clockId: "source-clock",
          segments: [{ id: "segment-1", startTime: "10 ticks", endTime: "20 ticks", text: "Hello", provenance: "fixture" }],
        },
      } satisfies MediaProductRendererProps,
      component: TranscriptCaptionScreen,
      projectionKey: "transcript",
      projection: {
        view: "review-transcript",
        sourceArtifactVersion: "source-v5",
        clockId: "source-clock",
        segments: [{ id: "segment-1", startTime: "10 ticks", endTime: "20 ticks", text: "Hello", provenance: "fixture" }],
      },
    },
  ])("selects the public $name family and forwards the shared host ports", ({ props, component, projectionKey, projection }) => {
    const element = MediaProductRenderer(props);
    const screenProps = element.props as Record<string, unknown>;
    expect(element.type).toBe(component);
    expect(screenProps.data).toBe(common.data);
    expect(screenProps.actionPort).toBe(actionPort);
    expect(screenProps.navigationPort).toBe(navigationPort);
    expect(screenProps.context).toBe(common.context);
    expect(screenProps[projectionKey]).toEqual(projection);
  });

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
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("<progress");
  });

  it("uses CSP-compatible native progress for measured operation progress", () => {
    const html = renderToStaticMarkup(React.createElement(MediaTaskFlow, {
      currentProjection: {
        title: "Upload media",
        description: "Transfer the selected source.",
        steps: [{ id: "upload", title: "Upload", description: "Send source bytes.", state: "current" }],
        currentStepId: "upload",
      },
      operationObservation: {
        state: "UPLOADING",
        progress: { kind: "determinate", value: 42, label: "Upload progress" },
      },
      children: React.createElement("p", null, "Upload details"),
    }));

    expect(html).toContain('<progress class="media-progress media-progress--primary" max="100"');
    expect(html).toContain('value="42"');
    expect(html).toContain('aria-label="Upload progress"');
    expect(html).not.toMatch(/<progress[^>]*style=/);
  });

  it("uses native indeterminate progress without inventing a percentage", () => {
    const html = renderToStaticMarkup(React.createElement(MediaTaskFlow, {
      currentProjection: {
        title: "Verify media",
        description: "Wait for integrity verification.",
        steps: [{ id: "verify", title: "Verify", description: "Check the recorded integrity result.", state: "current" }],
        currentStepId: "verify",
      },
      operationObservation: {
        state: "VERIFYING",
        progress: { kind: "indeterminate", label: "Verification progress" },
      },
      children: React.createElement("p", null, "Verification details"),
    }));

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Verification progress"');
    expect(html).toMatch(/<progress[^>]*aria-busy="true"[^>]*><\/progress>/);
    expect(html).not.toMatch(/<progress[^>]*value=/);
    expect(html).toContain("Progress is ongoing; amount is not measured.");
  });

  it("keeps absent measurement as explanatory text without a progress control", () => {
    const html = renderToStaticMarkup(React.createElement(MediaTaskFlow, {
      currentProjection: {
        title: "Review media",
        description: "Inspect the completed source.",
        steps: [{ id: "review", title: "Review", description: "Inspect media.", state: "current" }],
        currentStepId: "review",
      },
      operationObservation: { state: "READY", progress: { kind: "none" } },
      children: React.createElement("p", null, "Review details"),
    }));

    expect(html).toContain("No meaningful progress measurement is available.");
    expect(html).not.toContain("<progress");
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
