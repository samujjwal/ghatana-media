// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EmptyState, FileUpload } from "../foundations";
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

describe("Shared control reuse in Media screens", () => {
  it("announces project dispatch outcomes and prevents duplicate dispatch while pending", async () => {
    let resolveDispatch: ((value: { status: "denied"; reason: string }) => void) | undefined;
    const invoke = vi.fn(() => new Promise<{ status: "denied"; reason: string }>((resolve) => { resolveDispatch = resolve; }));
    const payload = { selectedAuthorizedWorkspaceId: "workspace-1", title: "Rough cut", requestId: "create-1" };
    const subjectRefs = ["workspace:workspace-1", "project-create:create-1"];
    render(React.createElement(FirstUseProjectScreen, {
      data,
      actions: [{ id: "media.action.create-project", label: "Create project", enabled: true, payload, subjectRefs }],
      actionPort: { invoke },
      context,
      project: { view: "find-projects", workspaceName: "Studio", selectedAuthorizedWorkspaceId: "workspace-1", accessState: "resolved", projects: [], projectNameDraft: "Rough cut" },
    }));

    expect(screen.getByText("Confirm project creation: “Rough cut” in workspace “Studio”.")).toBeTruthy();
    const createButton = screen.getByRole("button", { name: "Create project" });
    fireEvent.click(createButton);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("media.action.create-project", payload, { subjectRefs });
    expect(screen.getByText(/Requesting project creation; completion remains unknown/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Waiting for project outcome…" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Waiting for project outcome…" }));
    expect(invoke).toHaveBeenCalledTimes(1);

    resolveDispatch?.({ status: "denied", reason: "Workspace access was revoked." });
    expect((await screen.findByText("Project creation was denied.")).getAttribute("data-state")).toBe("denied");
  });

  it("reports an uncertain project request when dispatch throws", async () => {
    const invoke = vi.fn(async () => { throw new Error("Bearer secret-token from transport detail"); });
    render(React.createElement(FirstUseProjectScreen, {
      data,
      actions: [{ id: "media.action.create-project", label: "Create project", enabled: true,
        payload: { selectedAuthorizedWorkspaceId: "workspace-1", title: "Rough cut", requestId: "create-1" },
        subjectRefs: ["workspace:workspace-1", "project-create:create-1"] }],
      actionPort: { invoke },
      context,
      project: { view: "find-projects", workspaceName: "Studio", selectedAuthorizedWorkspaceId: "workspace-1", accessState: "resolved", projects: [], projectNameDraft: "Rough cut" },
    }));

    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect((await screen.findByText("Request outcome is unknown. Reconcile the exact project request before retrying.")).getAttribute("data-state")).toBe("unknown");
    expect(screen.queryByText(/Bearer secret-token/)).toBeNull();
    const button = screen.getByRole("button", { name: "Waiting for project outcome…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps an acknowledged project request locked until owner reconciliation", async () => {
    const invoke = vi.fn(async () => ({ status: "request-acknowledged" as const, requestId: "request-1" }));
    render(React.createElement(FirstUseProjectScreen, {
      data,
      actions: [{ id: "media.action.create-project", label: "Create project", enabled: true,
        payload: { selectedAuthorizedWorkspaceId: "workspace-1", title: "Rough cut", requestId: "request-1" },
        subjectRefs: ["workspace:workspace-1", "project-create:request-1"] }],
      actionPort: { invoke },
      context,
      project: { view: "find-projects", workspaceName: "Studio", selectedAuthorizedWorkspaceId: "workspace-1", accessState: "resolved", projects: [], projectNameDraft: "Rough cut" },
    }));

    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByText("The project request was acknowledged. Completion remains unobserved.")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Waiting for project outcome…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps a mismatched host request identity unknown and locked", async () => {
    const invoke = vi.fn(async () => ({ status: "request-acknowledged" as const, requestId: "different-request" }));
    render(React.createElement(FirstUseProjectScreen, {
      data,
      actions: [{ id: "media.action.create-project", label: "Create project", enabled: true,
        payload: { selectedAuthorizedWorkspaceId: "workspace-1", title: "Rough cut", requestId: "request-1" },
        subjectRefs: ["workspace:workspace-1", "project-create:request-1"] }],
      actionPort: { invoke },
      context,
      project: { view: "find-projects", workspaceName: "Studio", selectedAuthorizedWorkspaceId: "workspace-1", accessState: "resolved", projects: [], projectNameDraft: "Rough cut" },
    }));

    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect((await screen.findByText("Request outcome is unknown. Reconcile the exact project request before retrying.")).getAttribute("data-state")).toBe("unknown");
    expect(screen.queryByText("different-request")).toBeNull();
    expect((screen.getByRole("button", { name: "Waiting for project outcome…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps create disabled when the host has not supplied the exact owner request", () => {
    const invoke = vi.fn(async () => ({ status: "request-acknowledged" as const, requestId: "request-1" }));
    render(React.createElement(FirstUseProjectScreen, {
      data,
      actions: [{ id: "media.action.create-project", label: "Create project", enabled: true }],
      actionPort: { invoke },
      context,
      project: { view: "find-projects", workspaceName: "Studio", selectedAuthorizedWorkspaceId: "workspace-1", accessState: "resolved", projects: [], projectNameDraft: "Rough cut" },
    }));

    const button = screen.getByRole("button", { name: "Create project" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.getByText(/exact approved request and reconciliation references/)).toBeTruthy();
  });

  it("fails closed for a blank title, mismatched workspace, or missing reconciliation subject", () => {
    const invoke = vi.fn(async () => ({ status: "request-acknowledged" as const, requestId: "request-1" }));
    const cases = [
      {
        payload: { selectedAuthorizedWorkspaceId: "workspace-1", title: " ", requestId: "request-1" },
        selectedAuthorizedWorkspaceId: "workspace-1",
        projectNameDraft: " ",
        subjectRefs: ["workspace:workspace-1", "project-create:request-1"],
      },
      {
        payload: { selectedAuthorizedWorkspaceId: "workspace-1", title: "Rough cut", requestId: "request-1" },
        selectedAuthorizedWorkspaceId: "workspace-2",
        projectNameDraft: "Rough cut",
        subjectRefs: ["workspace:workspace-1", "project-create:request-1"],
      },
      {
        payload: { selectedAuthorizedWorkspaceId: "workspace-1", title: "Rough cut", requestId: "request-1" },
        selectedAuthorizedWorkspaceId: "workspace-1",
        projectNameDraft: "Rough cut",
        subjectRefs: [],
      },
    ];

    for (const candidate of cases) {
      const { unmount } = render(React.createElement(FirstUseProjectScreen, {
        data,
        actions: [{ id: "media.action.create-project", label: "Create project", enabled: true,
          payload: candidate.payload, subjectRefs: candidate.subjectRefs }],
        actionPort: { invoke },
        context,
        project: { view: "find-projects", workspaceName: "Studio", selectedAuthorizedWorkspaceId: candidate.selectedAuthorizedWorkspaceId,
          accessState: "resolved", projects: [], projectNameDraft: candidate.projectNameDraft },
      }));

      expect((screen.getByRole("button", { name: "Create project" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Create project" }));
      expect(invoke).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("keeps host-gated workflow steps as native buttons with current-step semantics", () => {
    const onStepSelect = vi.fn();
    const props = {
      currentProjection: {
        title: "Review media",
        description: "Move through the projected workflow.",
        steps: [
          { id: "review", title: "Review", description: "Inspect the result.", state: "current" as const },
          { id: "deliver", title: "Deliver", description: "Delivery follows review.", state: "available" as const, selectable: false, blockedReason: "Complete review first." },
        ],
        currentStepId: "review",
      },
      onStepSelect,
      children: React.createElement("p", null, "Workflow details"),
    };
    const html = renderToStaticMarkup(React.createElement(MediaTaskFlow, props));
    expect(html).toMatch(/<button[^>]*aria-current="step"/u);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-labelledby="media-step-deliver-number media-step-deliver-state media-step-deliver-title"[^>]*aria-describedby="media-step-deliver-description media-step-deliver-reason"/u);
    expect(html).toContain('<span id="media-step-deliver-number">2</span>');
    expect(html).toContain('<span id="media-step-deliver-state" class="media-step-state">available</span>');
    expect(html).toContain('<span id="media-step-deliver-title">Deliver</span>');
    expect(html).toContain('<span id="media-step-deliver-description">Delivery follows review.</span>');
    expect(html).toContain('<p id="media-step-deliver-reason">Complete review first.</p>');
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
    expect(projectHtml).toContain('class="gh-empty-state gh-empty-state--panel" data-size="md" role="status"');
    expect(projectHtml).toContain('<h3 class="gh-empty-state__title">No authorized projects are available in this workspace yet.</h3>');
    expect(projectHtml).not.toContain('style=');
    expect(artifactHtml).toContain('role="status" aria-label="No artifact records are available in this projection."');
    expect(artifactHtml).toContain('class="gh-empty-state gh-empty-state--panel" data-size="md" role="status"');
    expect(artifactHtml).toContain('<h3 class="gh-empty-state__title">No artifact records are available in this projection.</h3>');
    expect(artifactHtml).not.toContain('style=');
    expect(projectHtml.match(/gh-empty-state--panel/gu)).toHaveLength(1);
    expect(artifactHtml.match(/gh-empty-state--panel/gu)).toHaveLength(1);
  });

  it("uses the CSP-safe Shared FileUpload and keeps source selection as a native file affordance", () => {
    const onSourceFilesSelected = vi.fn();
    const props = {
      data,
      actionPort: { invoke: async () => ({ status: "request-acknowledged" as const, requestId: "request-file" }) },
      context,
      intake: { view: "import-media" as const },
      onSourceFilesSelected,
    };
    const element = React.createElement(ArtifactIntakeScreen, props);
    const html = renderToStaticMarkup(element);
    expect(html).toContain('class="gh-file-upload"');
    expect(html).toContain('<label for="media-source-files" class="gh-file-upload__label">Choose source media</label>');
    expect(html).toMatch(/<input[^>]*type="file"[^>]*multiple=""[^>]*id="media-source-files"/);
    expect(html).toContain('class="gh-file-upload__input"');
    expect(html).toContain('class="gh-file-upload__helper"');
    expect(html).not.toContain("style=");

    expect(html).toMatch(/<input type="file"[^>]*multiple=""/u);
    expect(onSourceFilesSelected).not.toHaveBeenCalled();
  });

  it("keeps project field labels and action behavior on native CSP-safe controls", () => {
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
    expect(html).not.toContain("data-ds=");
    expect(html).not.toContain(" style=");
    expect(html).toContain("Create project");

    expect(html).toContain('value="Rough cut"');
    expect(onProjectNameDraftChange).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();

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
    expect(html).not.toContain("data-ds=");
    expect(html).not.toContain(" style=");

    expect(html).toContain(">Hello</textarea>");
    expect(onCaptionEdit).not.toHaveBeenCalled();
    expect(onCaptionTimingDraftChange).not.toHaveBeenCalled();

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
    expect(compareHtml).toContain('value="v1"');
    expect(onCompareVersionSelection).not.toHaveBeenCalled();

    const sameVersionHtml = renderToStaticMarkup(React.createElement(TranscriptCaptionScreen, {
      ...compareProps,
      transcript: { ...compareProps.transcript, rightCompareVersionId: "v1" },
    }));
    expect(sameVersionHtml).toContain("Choose two distinct caption versions to compare.");
    expect(sameVersionHtml).toMatch(/<button[^>]*disabled=""[^>]*>Compare versions<\/button>/u);

    const staleVersionHtml = renderToStaticMarkup(React.createElement(TranscriptCaptionScreen, {
      ...compareProps,
      transcript: { ...compareProps.transcript, rightCompareVersionId: "v-stale" },
    }));
    expect(staleVersionHtml).toContain("Both selected caption versions must be available in this source projection.");
    expect(staleVersionHtml).toMatch(/<button[^>]*disabled=""[^>]*>Compare versions<\/button>/u);
  });
});
