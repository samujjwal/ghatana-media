import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Button, EmptyState, Select, TextArea, TextField } from "../foundations";
import { MediaTaskFlow } from "../components/MediaTaskFlow";
import { MediaTaskScreen } from "./MediaTaskScreen";
import { FirstUseProjectScreen } from "./FirstUseProjectScreen";
import { TranscriptCaptionScreen } from "./TranscriptCaptionScreen";
import { ArtifactIntakeScreen } from "./ArtifactIntakeScreen";
import type { MediaActionPort, MediaDataPort } from "../ports";

const data: MediaDataPort = {
  currentProjection: {
    title: "Edit captions",
    description: "Review and correct the transcript.",
    steps: [{ id: "review", title: "Review", description: "Review captions.", state: "current" }],
    currentStepId: "review",
  },
};
const context = { locale: "en-US" };

function sharedControls(root: React.ReactNode): React.ReactElement[] {
  const controls: React.ReactElement[] = [];
  const visit = (node: React.ReactNode): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!React.isValidElement(node)) return;
    if ([Button, EmptyState, Select, TextArea, TextField].includes(node.type as never)) {
      controls.push(node);
      return;
    }
    if (node.type === FirstUseProjectScreen || node.type === TranscriptCaptionScreen || node.type === MediaTaskScreen || node.type === MediaTaskFlow) {
      visit((node.type as (props: never) => React.ReactNode)(node.props as never));
      return;
    }
    visit((node.props as { children?: React.ReactNode }).children);
  };
  visit(root);
  return controls;
}

function controlProps(control: React.ReactElement): Record<string, unknown> {
  return control.props as Record<string, unknown>;
}

describe("Shared control reuse in Media screens", () => {
  it("keeps host-gated workflow steps as native buttons with current-step semantics", () => {
    const onStepSelect = vi.fn();
    const props = {
      currentProjection: {
        title: "Review media",
        description: "Move through the projected workflow.",
        steps: [
          { id: "review", title: "Review", description: "Inspect the result.", state: "current" as const },
          { id: "deliver", title: "Deliver", description: "Not yet selectable.", state: "available" as const, selectable: false },
        ],
        currentStepId: "review",
      },
      onStepSelect,
      children: React.createElement("p", null, "Workflow details"),
    };
    const html = renderToStaticMarkup(React.createElement(MediaTaskFlow, props));
    expect(html).toContain('<button type="button" aria-current="step"');
    expect(html).toContain('<button type="button" disabled=""');
    expect(html).not.toContain('data-ds="button"');

    const flowTree = MediaTaskFlow(props);
    const stepButtons: React.ReactElement[] = [];
    const visit = (node: React.ReactNode): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (!React.isValidElement(node)) return;
      if (node.type === "button") stepButtons.push(node);
      else visit((node.props as { children?: React.ReactNode }).children);
    };
    visit(flowTree);
    expect(stepButtons).toHaveLength(2);
    (stepButtons[0]!.props as { onClick: () => void }).onClick();
    (stepButtons[1]!.props as { onClick: () => void }).onClick();
    expect(onStepSelect).toHaveBeenCalledTimes(1);
    expect(onStepSelect).toHaveBeenCalledWith("review");
  });

  it("uses the CSP-safe Shared EmptyState for empty project and artifact collections", () => {
    const actionPort: MediaActionPort = {
      invoke: async () => ({ status: "request-acknowledged", requestId: "request-empty" }),
    };
    const projectHtml = renderToStaticMarkup(React.createElement(FirstUseProjectScreen, {
      data,
      actionPort,
      context,
      project: { view: "find-projects", accessState: "resolved", projects: [] },
    }));
    const artifactHtml = renderToStaticMarkup(React.createElement(ArtifactIntakeScreen, {
      data,
      actionPort,
      context,
      intake: { view: "browse-media", artifacts: [] },
    }));

    expect(projectHtml).toContain('role="status" aria-label="No authorized projects are available in this workspace yet."');
    expect(projectHtml).toContain("<h3 class=\"font-semibold text-gray-900 text-lg\">No authorized projects are available in this workspace yet.</h3>");
    expect(projectHtml).not.toMatch(/<div class="[^"]*flex flex-col[^"]*"[^>]*style=/);
    expect(artifactHtml).toContain('role="status" aria-label="No artifact records are available in this projection."');
    expect(artifactHtml).toContain("<h3 class=\"font-semibold text-gray-900 text-lg\">No artifact records are available in this projection.</h3>");
    expect(artifactHtml).not.toMatch(/<div class="[^"]*flex flex-col[^"]*"[^>]*style=/);
  });

  it("keeps project field labels and action behavior on Shared controls", () => {
    const onProjectNameDraftChange = vi.fn();
    const invoke = vi.fn(async () => ({ status: "request-acknowledged" as const, requestId: "request-1" }));
    const actionPort: MediaActionPort = { invoke };
    const props = {
      data,
      actions: [{ id: "media.action.create-project", label: "Create project", enabled: true }],
      actionPort,
      context,
      project: { view: "find-projects" as const, accessState: "resolved" as const, projects: [], projectNameDraft: "Rough cut" },
      onProjectNameDraftChange,
    };
    const html = renderToStaticMarkup(React.createElement(FirstUseProjectScreen, props));

    expect(html).toContain('<label for="new-project-name">Project name</label>');
    expect(html).toContain('id="new-project-name"');
    expect(html).toContain('data-ds="button"');
    expect(html).toContain("Create project");

    const controls = sharedControls(React.createElement(FirstUseProjectScreen, props));
    const field = controls.find((control) => control.type === TextField && controlProps(control).id === "new-project-name");
    const button = controls.find((control) => control.type === Button && controlProps(control).children === "Create project");
    expect(field).toBeDefined();
    expect(button).toBeDefined();
    (controlProps(field!).onChange as (event: unknown) => void)({ currentTarget: { value: "New name" } });
    (controlProps(button!).onClick as () => void)();
    expect(onProjectNameDraftChange).toHaveBeenCalledWith("New name");
    expect(invoke).toHaveBeenCalledWith("media.action.create-project", { name: "Rough cut" });

    const disabledHtml = renderToStaticMarkup(React.createElement(FirstUseProjectScreen, {
      ...props,
      actions: [{ id: "media.action.create-project", label: "Create project", enabled: false }],
    }));
    expect(disabledHtml).toContain('id="new-project-name"');
    expect(disabledHtml).toMatch(/<input[^>]*id="new-project-name"[^>]*disabled=""/);
    expect(disabledHtml).toContain('<button type="button" disabled=""');
  });

  it("preserves caption IDs and forwards text, timing, and version-selection edits", () => {
    const onCaptionEdit = vi.fn();
    const onCaptionTimingDraftChange = vi.fn();
    const onCompareVersionSelection = vi.fn();
    const invoke = vi.fn(async () => ({ status: "request-acknowledged" as const, requestId: "request-2" }));
    const props = {
      data,
      actions: [
        { id: "media.action.correct-caption", label: "Correct caption", enabled: true },
        { id: "media.action.align-caption-timing", label: "Apply timing alignment", enabled: true },
        { id: "media.action.compare-caption-versions", label: "Compare versions", enabled: true },
      ],
      actionPort: { invoke } satisfies MediaActionPort,
      context,
      transcript: {
        view: "correct-captions" as const,
        clockId: "source-clock",
        durationTicks: 100,
        segments: [{ id: "seg-1", startTime: "10", endTime: "20", startTick: 10, endTick: 20, text: "Hello" }],
        versions: [{ id: "v1", label: "Draft one" }, { id: "v2", label: "Draft two" }],
      },
      onCaptionEdit,
      onCaptionTimingDraftChange,
      onCompareVersionSelection,
    };
    const html = renderToStaticMarkup(React.createElement(TranscriptCaptionScreen, props));

    expect(html).toContain('<label for="caption-seg-1">Caption text for segment seg-1</label>');
    expect(html).toContain('id="caption-seg-1"');
    expect(html).toContain('id="caption-start-seg-1"');
    expect(html).toContain('id="caption-end-seg-1"');
    expect(html).toContain('data-ds="button"');

    const controls = sharedControls(React.createElement(TranscriptCaptionScreen, props));
    const caption = controls.find((control) => control.type === TextArea && controlProps(control).id === "caption-seg-1");
    const start = controls.find((control) => control.type === TextField && controlProps(control).id === "caption-start-seg-1");
    expect(caption).toBeDefined();
    expect(start).toBeDefined();
    (controlProps(caption!).onChange as (event: unknown) => void)({ currentTarget: { value: "Hello there" } });
    (controlProps(start!).onChange as (event: unknown) => void)({ currentTarget: { value: "12" } });
    expect(onCaptionEdit).toHaveBeenCalledWith("seg-1", "Hello there");
    expect(onCaptionTimingDraftChange).toHaveBeenCalledWith("seg-1", "startTick", 12);

    const compareProps = {
      ...props,
      transcript: {
        ...props.transcript,
        view: "compare-caption-versions" as const,
        leftCompareVersionId: "v1",
        rightCompareVersionId: "v2",
      },
    };
    const compareElement = React.createElement(TranscriptCaptionScreen, compareProps);
    const compareHtml = renderToStaticMarkup(compareElement);
    expect(compareHtml).toContain('<label for="caption-version-left">Earlier or source version</label>');
    expect(compareHtml).toContain('id="caption-version-left"');
    expect(compareHtml).toContain("Draft one — v1");
    const compareControl = sharedControls(compareElement)
      .find((control) => control.type === Select && controlProps(control).id === "caption-version-left");
    expect(compareControl).toBeDefined();
    (controlProps(compareControl!).onChange as (event: unknown) => void)({ currentTarget: { value: "v2" } });
    expect(onCompareVersionSelection).toHaveBeenCalledWith("left", "v2");
  });
});
