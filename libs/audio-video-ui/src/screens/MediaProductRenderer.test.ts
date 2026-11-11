// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaTaskScreen } from "./MediaTaskScreen";
import { MediaTaskFlow } from "../components/MediaTaskFlow";
import { mediaActionFeedbackElement, mediaActionFeedbackForResult } from "../components/MediaActionFeedback";
import { ArtifactIntakeScreen } from "./ArtifactIntakeScreen";
import { ArtifactInspectionScreen } from "./ArtifactInspectionScreen";
import { FirstUseProjectScreen } from "./FirstUseProjectScreen";
import { JobRecoveryScreen } from "./JobRecoveryScreen";
import { TranscriptCaptionScreen } from "./TranscriptCaptionScreen";
import {
  MEDIA_PRODUCT_RENDERER_ROUTE_DISPOSITIONS,
  MEDIA_PRODUCT_SCREEN_REALIZATION_DISPOSITIONS,
  MEDIA_SCREEN_COMPONENTS,
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

afterEach(cleanup);

describe("MediaProductRenderer", () => {
  it("does not expose host exception details in an unknown action result", async () => {
    const invoke = vi.fn(async () => { throw new Error("Bearer secret-token; tenant=private-tenant"); });
    render(React.createElement(MediaTaskScreen, {
      ...common,
      actionPort: { invoke },
      children: React.createElement("p", null, "Job details"),
    }));

    fireEvent.click(screen.getByRole("button", { name: "Check job outcome" }));

    const status = await screen.findByText(
      "Request outcome is unknown. Reconcile with the owner before retrying.", { exact: true },
    );
    expect(status.getAttribute("data-state")).toBe("unknown");
    expect(document.body.textContent).not.toContain("secret-token");
    expect(document.body.textContent).not.toContain("private-tenant");
  });

  it("announces typed pending, denied, and unknown action states accessibly", () => {
    const pending = renderToStaticMarkup(mediaActionFeedbackElement(
      { state: "pending", message: "Requesting action; completion remains unknown." },
    ));
    expect(pending).toContain('role="status" aria-live="polite" aria-atomic="true" aria-busy="true" data-state="pending"');
    expect(pending).toContain("Requesting action; completion remains unknown.");

    const deniedValue = mediaActionFeedbackForResult({ status: "denied", reason: "Rights approval is missing." });
    expect(deniedValue).toEqual({ state: "denied", message: "Action denied: Rights approval is missing." });
    const denied = renderToStaticMarkup(mediaActionFeedbackElement(deniedValue));
    expect(denied).toContain('data-state="denied"');
    expect(denied).toContain("Action denied: Rights approval is missing.");

    const unknown = renderToStaticMarkup(mediaActionFeedbackElement(
      { state: "unknown", message: "Request outcome is unknown. Reconcile before retrying." },
    ));
    expect(unknown).toContain('data-state="unknown"');
    expect(unknown).toContain("Reconcile before retrying.");
    expect(unknown).not.toContain('aria-busy="true"');
  });

  it("classifies every screen contract without admitting a product route", () => {
    const dispositions = Object.values(MEDIA_PRODUCT_SCREEN_REALIZATION_DISPOSITIONS);
    const counts = dispositions.reduce<Record<string, number>>((result, item) => {
      result[item.status] = (result[item.status] ?? 0) + 1;
      expect(item.productRoute).toBe("NOT_ADMITTED");
      return result;
    }, {});

    expect(Object.keys(MEDIA_PRODUCT_SCREEN_REALIZATION_DISPOSITIONS).sort()).toEqual(Object.keys(MEDIA_SCREEN_COMPONENTS).sort());
    expect(dispositions).toHaveLength(47);
    expect(counts).toEqual({ LOCAL_SIMULATION: 12, CONTRACT_PREVIEW: 35 });
    expect(dispositions.some(({ status }) => status === "LIVE_IMPLEMENTED")).toBe(false);
    expect(dispositions.some(({ status }) => status === "NOT_ADMITTED")).toBe(false);
  });

  it("keeps renderer and per-screen route dispositions immutable at runtime", () => {
    expect(Object.isFrozen(MEDIA_PRODUCT_RENDERER_ROUTE_DISPOSITIONS)).toBe(true);
    expect(Object.isFrozen(MEDIA_PRODUCT_RENDERER_ROUTE_DISPOSITIONS["job-recovery"])).toBe(true);
    expect(Object.isFrozen(MEDIA_PRODUCT_SCREEN_REALIZATION_DISPOSITIONS)).toBe(true);
    expect(Object.isFrozen(MEDIA_PRODUCT_SCREEN_REALIZATION_DISPOSITIONS["media.view.inspect-media"])).toBe(true);
    expect(Reflect.set(MEDIA_PRODUCT_RENDERER_ROUTE_DISPOSITIONS["job-recovery"], "productRoute", "ADMITTED")).toBe(false);
    expect(Reflect.set(MEDIA_PRODUCT_SCREEN_REALIZATION_DISPOSITIONS["media.view.inspect-media"], "status", "LIVE_IMPLEMENTED")).toBe(false);
    expect(MEDIA_PRODUCT_RENDERER_ROUTE_DISPOSITIONS["job-recovery"].productRoute).toBe("NOT_ADMITTED");
    expect(MEDIA_PRODUCT_SCREEN_REALIZATION_DISPOSITIONS["media.view.inspect-media"]).toEqual({
      status: "LOCAL_SIMULATION",
      productRoute: "NOT_ADMITTED",
    });
  });

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
      name: "artifact inspection",
      props: { kind: "artifact-inspection", ...common, artifactId: "artifact-7" } satisfies MediaProductRendererProps,
      component: ArtifactInspectionScreen,
      projectionKey: "artifactId",
      projection: "artifact-7",
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
    expect(html).toContain("Canonical job status refresh is NOT_ADMITTED. No live status was requested.");
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("<progress");
  });

  it("forwards the optional canonical job reader without creating a product route", () => {
    const canonicalJobReadClient = { getJob: vi.fn(async () => ({ jobId: "media-job-42", status: "COMPLETED" as const, version: 3 })) };
    const props: MediaProductRendererProps = {
      kind: "job-recovery",
      ...common,
      job: { jobId: "media-job-42" },
      canonicalJobReadClient,
    };
    const element = MediaProductRenderer(props);

    expect(element.type).toBe(JobRecoveryScreen);
    expect((element.props as { canonicalJobReadClient?: unknown }).canonicalJobReadClient).toBe(canonicalJobReadClient);
    expect(MEDIA_PRODUCT_RENDERER_ROUTE_DISPOSITIONS["job-recovery"].productRoute).toBe("NOT_ADMITTED");
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
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('<h2 id="media-operation-title">uploading</h2>');
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

  it("renders the projected job outcome and leaves dispatch to the action boundary", () => {
    actionPort.invoke.mockClear();
    const props: MediaProductRendererProps = {
      kind: "job-recovery",
      ...common,
      job: { jobId: "media-job-42", finality: "UNKNOWN" },
    };
    const html = renderToStaticMarkup(React.createElement(MediaProductRenderer, props));
    expect(html).toContain("Job status and recovery");
    expect(html).toContain("UNKNOWN");
    expect(html).toContain("Check job outcome");
    expect(actionPort.invoke).not.toHaveBeenCalled();
  });

  it("renders RTL transcript timing with labeled native keyboard controls and an announced unknown status", () => {
    const props: MediaProductRendererProps = {
      kind: "transcript-caption",
      ...common,
      context: { locale: "ar", direction: "rtl" },
      actions: [
        { id: "media.action.correct-caption", label: "Apply caption correction", enabled: true },
        { id: "media.action.align-caption-timing", label: "Apply timing alignment", enabled: true },
      ],
      transcript: {
        view: "correct-captions",
        sourceArtifactId: "artifact-1",
        sourceArtifactVersionId: "artifact-version-1",
        parentVersionKind: "TRANSCRIPT_VERSION",
        parentVersionId: "transcript-version-1",
        captionDraftVersion: "caption-draft-1",
        captionDraftRevision: 0,
        clockId: "source-clock",
        ticksPerSecond: 48_000,
        durationTicks: 100,
        segments: [{ id: "seg-1", startTime: "10", endTime: "20", startTick: 10, endTick: 20, text: "مرحبا" }],
      },
    };

    const html = renderToStaticMarkup(React.createElement(MediaProductRenderer, props));

    expect(html).toContain('<div dir="rtl" lang="ar">');
    expect(html).toContain('role="status"');
    expect(html).toContain('<label for="caption-start-seg-1">Start tick</label>');
    expect(html).toContain('<input id="caption-start-seg-1" class="media-input" type="number"');
    expect(html).toContain('<label for="caption-end-seg-1">End tick</label>');
    expect(html).toContain('<input id="caption-end-seg-1" class="media-input" type="number"');
    expect(html).toContain('Timing in source clock ticks (source-clock)');
    expect(html).toContain('<button type="button" class="media-action-button media-action-button--primary">Apply timing alignment</button>');
  });
});
