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
  it.each(["denied", "unknown", "loading"] as const)("hides project details when access is %s", (accessState) => {
    const html = renderToStaticMarkup(React.createElement(FirstUseProjectScreen, {
      ...baseProps,
      project: {
        view: "find-projects",
        accessState,
        workspaceName: "Workspace label",
        projectName: "Protected project",
        projects: [{ id: "private-project-id", name: "Private project" }],
      },
    }));

    expect(html).toContain('role="status"');
    expect(html).not.toContain("Workspace label");
    expect(html).not.toContain("Protected project");
    expect(html).not.toContain("Private project");
    expect(html).not.toContain("private-project-id");
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
      },
    }));

    expect(html).toContain("Authorized project");
    expect(html).toContain("Authorized workspace");
    expect(html).toContain("Visible project");
    expect(html).toContain("authorized-project-id");
  });
});
