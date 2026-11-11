import React from "react";
import { createRoot } from "react-dom/client";
import type { DevProject, DevProjectRevision, MediaDevProjectTimelineClient } from "@audio-video/client/dev-project-timeline";
import { MediaProductRenderer } from "@audio-video/ui/screens";

type WorkspaceDetail = {
  readonly client: MediaDevProjectTimelineClient;
  readonly project: DevProject;
  readonly revision: DevProjectRevision;
};
const rootElement = document.getElementById("timeline-workspace-root");
if (!rootElement) throw new Error("Missing reusable project timeline workspace mount.");
const root = createRoot(rootElement);

rootElement.addEventListener("media-dev-project-timeline", ((event: CustomEvent<WorkspaceDetail | null>) => {
  const detail = event.detail;
  if (!detail) { root.render(null); return; }
  root.render(React.createElement(MediaProductRenderer, {
    kind: "dev-project-timeline",
    client: detail.client,
    project: detail.project,
    revision: detail.revision,
  }));
}) as EventListener);
