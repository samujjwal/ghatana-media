import React from "react";
import { createRoot } from "react-dom/client";
import type { DevProject, DevProjectRevision, MediaDevProjectTimelineClient } from "@audio-video/client/dev-project-timeline";
import { DevOfflineDraftsPanel, DevReviewSection, DevRightsSection, MediaProductRenderer } from "@audio-video/ui/screens";
import type { DevProjectOutputsPort } from "@audio-video/ui/screens";

type WorkspaceDetail = {
  readonly client: MediaDevProjectTimelineClient;
  readonly project: DevProject;
  readonly revision: DevProjectRevision;
  readonly outputs: DevProjectOutputsPort;
  /** Verified principal from the host context; scopes the browser-held offline draft key. */
  readonly principalId: string;
};
const rootElement = document.getElementById("timeline-workspace-root");
if (!rootElement) throw new Error("Missing reusable project timeline workspace mount.");
const root = createRoot(rootElement);

rootElement.addEventListener("media-dev-project-timeline", ((event: CustomEvent<WorkspaceDetail | null>) => {
  const detail = event.detail;
  if (!detail) { root.render(null); return; }
  root.render(React.createElement(React.Fragment, null,
    React.createElement(MediaProductRenderer, {
      kind: "dev-project-timeline",
      client: detail.client,
      project: detail.project,
      revision: detail.revision,
      outputs: detail.outputs,
    }),
    React.createElement(DevOfflineDraftsPanel, {
      client: detail.client,
      project: detail.project,
      revision: detail.revision,
      principalId: detail.principalId,
    })));
}) as EventListener);

// Standalone assigned-reviewer view: opens an existing case by id; needs no project access.
const reviewRootElement = document.getElementById("review-workspace-root");
if (reviewRootElement) {
  const reviewRoot = createRoot(reviewRootElement);
  reviewRootElement.addEventListener("media-dev-reviewer", ((event: CustomEvent<DevProjectOutputsPort | null>) => {
    const outputs = event.detail;
    if (!outputs) { reviewRoot.render(null); return; }
    reviewRoot.render(React.createElement(React.Fragment, null,
      React.createElement(DevReviewSection, {
        key: outputs.principalId ?? "unknown", outputs, locked: false, newRequestId: () => `ui-${crypto.randomUUID()}`,
        projectId: null, headKey: null, subjectChoices: [],
      }),
      // Second-person lane: open an uploader's rights statement by id and confirm or revoke it as yourself.
      React.createElement(DevRightsSection, { key: `rights:${outputs.principalId ?? "unknown"}`, outputs, locked: false, artifact: null, idPrefix: "confirmer" })));
  }) as EventListener);
}
