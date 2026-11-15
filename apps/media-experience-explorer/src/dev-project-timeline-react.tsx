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

// The last head the page observed (after any online edit) is the base of drafts saved offline.
let observed: DevProjectRevision | null = null;
let current: WorkspaceDetail | null = null;
const renderWorkspace = (): void => {
  const detail = current;
  if (!detail) { root.render(null); return; }
  const revisionForDrafts = observed && observed.projectId === detail.project.projectId ? observed : detail.revision;
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
      revision: revisionForDrafts,
      principalId: detail.principalId,
    })));
};

rootElement.addEventListener("media-dev-project-timeline", ((event: CustomEvent<WorkspaceDetail | null>) => {
  current = event.detail;
  observed = null;
  renderWorkspace();
}) as EventListener);
rootElement.addEventListener("media-dev-head-observed", ((event: CustomEvent<DevProjectRevision>) => {
  observed = event.detail;
  if (current) renderWorkspace();
}) as EventListener);

// Offline restore: after a reload, the encrypted drafts of the last opened project are listed before (and without) any
// host connection. Replay still needs a fresh token and review.
const restoreElement = document.getElementById("offline-restore-root");
if (restoreElement) {
  const restoreRoot = createRoot(restoreElement);
  let restore: WorkspaceDetail | null = null;
  let restoreObserved: DevProjectRevision | null = null;
  const renderRestore = (): void => {
    if (!restore) { restoreRoot.render(null); return; }
    const revision = restoreObserved && restoreObserved.projectId === restore.project.projectId ? restoreObserved : restore.revision;
    restoreRoot.render(React.createElement(DevOfflineDraftsPanel, {
      key: `${restore.project.projectId}:${restore.principalId}`,
      client: restore.client, project: restore.project, revision, principalId: restore.principalId,
    }));
  };
  restoreElement.addEventListener("media-dev-offline-restore", ((event: CustomEvent<WorkspaceDetail | null>) => {
    restore = event.detail; restoreObserved = null; renderRestore();
  }) as EventListener);
  restoreElement.addEventListener("media-dev-head-observed", ((event: CustomEvent<DevProjectRevision>) => {
    restoreObserved = event.detail; if (restore) renderRestore();
  }) as EventListener);
}

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
