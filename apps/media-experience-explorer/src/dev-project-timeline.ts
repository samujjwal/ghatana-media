import "./dev-project-timeline-react";
import { openExistingProject } from "./dev-open-project";
import { createDevProjectOutputsClient } from "./dev-project-outputs-client";
import type { DevProjectOutputsPort } from "@audio-video/ui/screens";
import {
  MediaDevProjectTimelineError,
  MediaDevProjectTimelineClient,
  type DevProjectContext,
  type DevProjectCreated,
  type DevProjectRead,
  type DevProjectRevision,
} from "@audio-video/client/dev-project-timeline";

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing page element: ${id}`);
  return element as T;
};

type ProjectRequest = { selectedAuthorizedWorkspaceId: string; title: string; requestId: string };
type WorkspaceDetail = { readonly client: MediaDevProjectTimelineClient; readonly project: DevProjectRead["project"]; readonly revision: DevProjectRevision; readonly outputs: DevProjectOutputsPort; readonly principalId: string };
const origin = window.location.origin;
const hostChip = byId<HTMLSpanElement>("host-origin");
const tokenInput = byId<HTMLInputElement>("dev-token");
const status = byId<HTMLParagraphElement>("status");
const contextFields = byId<HTMLDListElement>("context-fields");
const connectForm = byId<HTMLFormElement>("connect-form");
const connectButton = connectForm.querySelector<HTMLButtonElement>("button[type=submit]");
const forgetButton = byId<HTMLButtonElement>("forget-token");
const projectForm = byId<HTMLFormElement>("project-form");
const projectTitleInput = byId<HTMLInputElement>("project-title");
const createProjectButton = byId<HTMLButtonElement>("create-project");
const replayProjectButton = byId<HTMLButtonElement>("replay-project");
const projectResult = byId<HTMLDivElement>("project-result");
const projectJson = byId<HTMLPreElement>("project-json");
const openProjectForm = byId<HTMLFormElement>("open-project-form");
const openProjectIdInput = byId<HTMLInputElement>("open-project-id");
const openProjectButton = byId<HTMLButtonElement>("open-project");
const workspacePanel = byId<HTMLElement>("timeline-workspace-panel");
const workspaceRoot = byId<HTMLDivElement>("timeline-workspace-root");
if (!connectButton) throw new Error("Missing connect button.");

let bearerToken: string | null = null;
let client: MediaDevProjectTimelineClient | null = null;
let context: DevProjectContext | null = null;
let lastCreateRequest: ProjectRequest | null = null;
let unresolvedProjectCreate = false;

hostChip.textContent = origin;

connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) { announce("Paste a raw DEV_ONLY token to connect.", "error"); tokenInput.focus(); return; }
  try { client = new MediaDevProjectTimelineClient({ baseUrl: origin, bearerToken: () => bearerToken ?? "" }); }
  catch (error) { announce(errorMessage(error), "error"); return; }
  bearerToken = token;
  tokenInput.value = "";
  tokenInput.disabled = true;
  connectButton.disabled = true;
  forgetButton.disabled = false;
  announce("Reading DEV_ONLY host context…");
  try {
    context = await client.getContext();
    renderContext(context);
    setConnected(true);
    announce(`Connected to the local host. Scope: ${context.scope}.`, "success");
    projectTitleInput.focus();
  } catch (error) { announce(errorMessage(error), "error"); }
});

forgetButton.addEventListener("click", () => {
  bearerToken = null;
  client = null;
  context = null;
  lastCreateRequest = null;
  unresolvedProjectCreate = false;
  openProjectIdInput.value = "";
  workspaceRoot.dispatchEvent(new CustomEvent<WorkspaceDetail | null>("media-dev-project-timeline", { detail: null }));
  workspacePanel.hidden = true;
  tokenInput.value = "";
  tokenInput.disabled = false;
  connectButton.disabled = false;
  forgetButton.disabled = true;
  contextFields.replaceChildren();
  contextFields.hidden = true;
  projectResult.hidden = true;
  projectJson.textContent = "";
  setConnected(false);
  announce("Disconnected. The in-memory token and current project context were cleared.");
  tokenInput.focus();
});

projectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!client || !context) return;
  if (unresolvedProjectCreate && lastCreateRequest) {
    announce("Project creation outcome is unknown. Replay the exact saved request before starting another create.", "error");
    return;
  }
  const title = projectTitleInput.value;
  if (!title.trim()) { announce("Project title must contain a non-whitespace character.", "error"); projectTitleInput.focus(); return; }
  if ([...title].length > 200) { announce("Project title must be at most 200 Unicode code points.", "error"); projectTitleInput.focus(); return; }
  const request: ProjectRequest = {
    selectedAuthorizedWorkspaceId: context.selectedAuthorizedWorkspaceId,
    title,
    requestId: createRequestId(),
  };
  lastCreateRequest = request;
  await createProject(request, false);
});

replayProjectButton.addEventListener("click", async () => {
  if (lastCreateRequest) await createProject(lastCreateRequest, true);
});

async function createProject(request: ProjectRequest, replay: boolean): Promise<void> {
  if (!client) return;
  setBusy(true);
  announce(replay ? "Replaying the same project create request…" : "Creating project…");
  let createAcknowledged = false;
  try {
    const result: DevProjectCreated = await client.createProject(request);
    createAcknowledged = true;
    if (result.scope !== "DEV_ONLY" || result.project.workspaceId !== request.selectedAuthorizedWorkspaceId) throw new Error("Host response did not match the DEV_ONLY workspace request.");
    const exactRevision = await client.getRevision(result.project.projectId, result.initialRevision.revisionId);
    if (exactRevision.scope !== "DEV_ONLY" || exactRevision.revision.projectId !== result.project.projectId
      || exactRevision.revision.tenantId !== result.project.tenantId || exactRevision.revision.revisionId !== result.project.headRevisionId
      || exactRevision.revision.revisionId !== result.initialRevision.revisionId || exactRevision.revision.timelines.length !== 0) {
      throw new Error("The exact initial project revision could not be confirmed.");
    }
    unresolvedProjectCreate = false;
    renderJson(projectResult, projectJson, result);
    workspacePanel.hidden = false;
    workspaceRoot.dispatchEvent(new CustomEvent<WorkspaceDetail>("media-dev-project-timeline", {
      detail: { client, project: result.project, revision: exactRevision.revision, outputs: createDevProjectOutputsClient({ origin, bearerToken: () => bearerToken ?? "" }), principalId: context?.principalId ?? "" },
    }));
    announce(`${result.createdNow ? "Created" : "Replayed"} DEV_ONLY project ${result.project.projectId}; exact initial revision ${exactRevision.revision.revisionId} reopened.`, "success");
  } catch (error) {
    unresolvedProjectCreate = createAcknowledged || (error instanceof MediaDevProjectTimelineError
      && (error.code === "OUTCOME_UNKNOWN" || error.code === "INVALID_RESPONSE"));
    announce(createAcknowledged
      ? "Project creation was acknowledged, but its exact initial revision could not be reopened. Replay the same request to reconcile it."
      : errorMessage(error), "error");
  } finally { setBusy(false); }
}

openProjectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!client || !context) return;
  setBusy(true);
  announce("Reading the existing project from the host…");
  try {
    const result = await openExistingProject(client, context, openProjectIdInput.value);
    if (!result.ok) { announce(result.message, "error"); return; }
    const { project, currentRevision } = result.read;
    renderJson(projectResult, projectJson, result.read);
    workspacePanel.hidden = false;
    workspaceRoot.dispatchEvent(new CustomEvent<WorkspaceDetail>("media-dev-project-timeline", {
      detail: { client, project, revision: currentRevision, outputs: createDevProjectOutputsClient({ origin, bearerToken: () => bearerToken ?? "" }), principalId: context?.principalId ?? "" },
    }));
    announce(`Opened existing DEV_ONLY project ${project.projectId}; current head revision ${currentRevision.revisionId} read from the host.`, "success");
  } finally { setBusy(false); }
});

function renderContext(value: DevProjectContext): void {
  contextFields.replaceChildren();
  for (const [label, field] of [
    ["Scope", value.scope], ["Tenant", value.tenantId], ["Principal", value.principalId],
    ["Selected workspace", value.workspaceName], ["Workspace ID", value.selectedAuthorizedWorkspaceId], ["Authority", value.authority],
  ]) {
    const wrapper = document.createElement("div");
    const term = document.createElement("dt"); term.textContent = label;
    const description = document.createElement("dd"); description.textContent = field;
    wrapper.append(term, description); contextFields.append(wrapper);
  }
  contextFields.hidden = false;
}

function renderJson(container: HTMLElement, output: HTMLPreElement, value: unknown): void {
  output.textContent = JSON.stringify(value, null, 2);
  container.hidden = false;
}

function setConnected(connected: boolean): void {
  createProjectButton.disabled = !connected;
  openProjectButton.disabled = !connected;
  replayProjectButton.disabled = !connected || !lastCreateRequest;
}

function setBusy(busy: boolean): void {
  if (connectButton) connectButton.disabled = busy || Boolean(context);
  createProjectButton.disabled = busy || !context || unresolvedProjectCreate;
  openProjectButton.disabled = busy || !context;
  replayProjectButton.disabled = busy || !context || !lastCreateRequest;
}

function announce(message: string, kind: "error" | "success" | "info" = "info"): void {
  status.textContent = message;
  status.dataset.kind = kind;
}

function errorMessage(error: unknown): string {
  if (error instanceof MediaDevProjectTimelineError) {
    if (error.code === "OUTCOME_UNKNOWN") return `OUTCOME_UNKNOWN: ${error.message}`;
    if (error.code === "INVALID_RESPONSE") return `UNKNOWN: ${error.message}`;
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : "UNKNOWN: local Media host request failed.";
}

function createRequestId(): string {
  return crypto.randomUUID();
}
