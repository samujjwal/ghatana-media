import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FirstUseProjectScreen, type FirstUseProjectScreenProps } from "./FirstUseProjectScreen";

const baseProps: Omit<FirstUseProjectScreenProps, "project"> = {
  data: {
    currentProjection: {
      title: "Your projects",
      description: "Choose an authorized project.",
      steps: [{ id: "projects", title: "Projects", description: "Review available projects.", state: "current" }],
      currentStepId: "projects",
    },
    operationObservation: { state: "IDLE", progress: { kind: "none" }, finality: "NOT_STARTED" },
  },
  actions: [],
  nextSafeActionIds: [],
  actionPort: { invoke: async () => ({ status: "unavailable", reason: "No action is admitted." }) },
  context: { locale: "en-US" },
};

describe("FirstUseProjectScreen protected project data", () => {
  it("associates the create action with its confirmation or unavailable explanation", () => {
    const ready = renderToStaticMarkup(React.createElement(FirstUseProjectScreen, {
      ...baseProps,
      actions: [{ id: "media.action.create-project", label: "Create project", enabled: true,
        payload: { selectedAuthorizedWorkspaceId: "workspace-1", title: "Rough cut", requestId: "create-1" },
        subjectRefs: ["workspace:workspace-1", "project-create:create-1"] }],
      project: { view: "find-projects", accessState: "resolved", workspaceName: "Studio",
        selectedAuthorizedWorkspaceId: "workspace-1", projectNameDraft: "Rough cut" },
    }));

    expect(ready).toContain('aria-describedby="create-project-confirmation"');
    expect(ready).toContain('id="create-project-confirmation"');

    const unavailable = renderToStaticMarkup(React.createElement(FirstUseProjectScreen, {
      ...baseProps,
      actions: [],
      project: { view: "find-projects", accessState: "unknown" },
    }));

    expect(unavailable).toContain('aria-describedby="create-project-unavailable"');
    expect(unavailable).toContain('id="create-project-unavailable"');
    expect(unavailable).toContain('disabled=""');
  });

  it("does not evaluate accessor properties in the host create payload", () => {
    let getterCalls = 0;
    const payload: Record<string, string> = {
      selectedAuthorizedWorkspaceId: "workspace-1",
      title: "Rough cut",
      requestId: "create-1",
    };
    Object.defineProperty(payload, "title", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("host payload getter must not run during rendering");
      },
    });

    const html = renderToStaticMarkup(React.createElement(FirstUseProjectScreen, {
      ...baseProps,
      actions: [{ id: "media.action.create-project", label: "Create project", enabled: true,
        payload, subjectRefs: ["workspace:workspace-1", "project-create:create-1"] }],
      project: { view: "find-projects", accessState: "resolved", workspaceName: "Studio",
        selectedAuthorizedWorkspaceId: "workspace-1", projectNameDraft: "Rough cut" },
    }));

    expect(getterCalls).toBe(0);
    expect(html).toContain('aria-describedby="create-project-unavailable"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("create-project-confirmation");
  });

  it.each(["denied", "unknown", "loading"] as const)("hides project details when access is %s", (accessState) => {
    const html = renderToStaticMarkup(React.createElement(FirstUseProjectScreen, {
      ...baseProps,
      project: {
        view: "find-projects",
        accessState,
        workspaceName: "Workspace label",
        projectName: "Protected project",
        projects: [{ id: "private-project-id", name: "Private project" }],
        message: "Private project status",
        returnDestination: "/projects/private-project-id",
      },
    }));

    expect(html).toContain('role="status"');
    expect(html).not.toContain("Workspace label");
    expect(html).not.toContain("Protected project");
    expect(html).not.toContain("Private project");
    expect(html).not.toContain("private-project-id");
    expect(html).not.toContain("Private project status");
    expect(html).not.toContain("/projects/private-project-id");
  });

  it("shows project details after the host confirms access", () => {
    const html = renderToStaticMarkup(React.createElement(FirstUseProjectScreen, {
      ...baseProps,
      project: {
        view: "find-projects",
        accessState: "resolved",
        workspaceName: "Authorized workspace",
        projectName: "Authorized project",
        projects: [{ id: "authorized-project-id", name: "Visible project" }],
        message: "Authorized project status",
        returnDestination: "/projects/authorized-project-id",
      },
    }));

    expect(html).toContain("Authorized project");
    expect(html).toContain("Authorized workspace");
    expect(html).toContain("Visible project");
    expect(html).toContain("authorized-project-id");
    expect(html).toContain("Authorized project status");
    expect(html).toContain("/projects/authorized-project-id");
  });
});
