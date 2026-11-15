import "./dev-project-timeline-react";
import { OidcLoginError, beginLogin, browserDeps, completeLogin, isCallback, readOidcConfig } from "./oidc-login";
import { openExistingProject } from "./dev-open-project";
import { createDevProjectOutputsClient } from "./dev-project-outputs-client";
import type { DevProjectOutputsPort } from "@audio-video/ui/screens";
import { readOfflineWorkspacePointer, restoredRevision, writeOfflineWorkspacePointer, type OfflineWorkspacePointer } from "./dev-offline-workspace";
import {
  MediaDevProjectTimelineError,
  MediaDevProjectTimelineClient,
  type DevProject,
  type DevProjectTimelineClientOptions,
  type DevRevisionRead,
  type CreateDevTimelineRequest,
  type EditDevTimelineRequest,
  type RestoreDevProjectRevisionRequest,
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

/** Reports every head the page observes so offline drafts are always authored against the last known head. */
class ObservingClient extends MediaDevProjectTimelineClient {
  constructor(options: DevProjectTimelineClientOptions, private readonly observe: (revision: DevProjectRevision) => void) { super(options); }
  override async getProject(projectId: string, signal?: AbortSignal): Promise<DevProjectRead> {
    const read = await super.getProject(projectId, signal); this.observe(read.currentRevision); return read;
  }
  override async createTimeline(projectId: string, request: CreateDevTimelineRequest, signal?: AbortSignal): Promise<DevRevisionRead> {
    const read = await super.createTimeline(projectId, request, signal); this.observe(read.revision); return read;
  }
  override async editTimeline(projectId: string, timelineId: string, request: EditDevTimelineRequest, signal?: AbortSignal): Promise<DevRevisionRead> {
    const read = await super.editTimeline(projectId, timelineId, request, signal); this.observe(read.revision); return read;
  }
  override async restoreRevision(projectId: string, request: RestoreDevProjectRevisionRequest, signal?: AbortSignal): Promise<DevRevisionRead> {
    const read = await super.restoreRevision(projectId, request, signal); this.observe(read.revision); return read;
  }
}

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
const oidcButton = byId<HTMLButtonElement>("oidc-login");
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
const reviewerPanel = byId<HTMLElement>("reviewer-panel");
const reviewerRoot = byId<HTMLDivElement>("review-workspace-root");
const restorePanel = byId<HTMLElement>("offline-restore-panel");
const restoreRoot = byId<HTMLDivElement>("offline-restore-root");
if (!connectButton) throw new Error("Missing connect button.");

let bearerToken: string | null = null;
let client: MediaDevProjectTimelineClient | null = null;
let context: DevProjectContext | null = null;
let lastCreateRequest: ProjectRequest | null = null;
let unresolvedProjectCreate = false;

hostChip.textContent = origin;

// ---- offline drafts: last-opened-project pointer, head observation, offline reload restore ----
let openProject: DevProject | null = null;
let openTimelineIds: readonly string[] = [];
const restoreClient = new ObservingClient({ baseUrl: origin, bearerToken: () => bearerToken ?? "" }, observeHead);

function observeHead(revision: DevProjectRevision): void {
  const pointer = readOfflineWorkspacePointer();
  const project = openProject ?? pointer?.project ?? null;
  if (!project || project.projectId !== revision.projectId || project.tenantId !== revision.tenantId) return;
  openProject = openProject ? { ...openProject, headRevisionId: revision.revisionId } : null;
  const timelineIds = revision.timelines.map((item) => item.graph.timelineId);
  if (openProject) openTimelineIds = timelineIds;
  const principalId = context?.principalId ?? pointer?.principalId;
  if (principalId) {
    writeOfflineWorkspacePointer({ v: 1, principalId, project: { ...project, headRevisionId: revision.revisionId }, timelineIds });
  }
  for (const root of [workspaceRoot, restoreRoot]) {
    root.dispatchEvent(new CustomEvent<DevProjectRevision>("media-dev-head-observed", { detail: revision }));
  }
}

function showRestorePanel(): void {
  const pointer: OfflineWorkspacePointer | null = openProject ? null : readOfflineWorkspacePointer();
  restorePanel.hidden = pointer === null;
  restoreRoot.dispatchEvent(new CustomEvent<WorkspaceDetail | null>("media-dev-offline-restore", {
    detail: pointer ? { client: restoreClient, project: pointer.project, revision: restoredRevision(pointer),
      outputs: null as unknown as DevProjectOutputsPort, principalId: pointer.principalId } : null,
  }));
}

function rememberOpenedWorkspace(project: DevProject, revision: DevProjectRevision): void {
  openProject = project;
  openTimelineIds = revision.timelines.map((item) => item.graph.timelineId);
  if (context) {
    writeOfflineWorkspacePointer({ v: 1, principalId: context.principalId, project, timelineIds: openTimelineIds });
  }
  showRestorePanel(); // the live workspace carries its own drafts panel; never mount two
}

// App-shell worker: lets a reload while offline still open this page (and its encrypted drafts). Best effort.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/dev-offline-sw.js", { scope: "/" }).catch(() => undefined);
}
showRestorePanel();

connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) { announce("Paste a raw DEV_ONLY token to connect.", "error"); tokenInput.focus(); return; }
  await connectWithToken(token);
});

/** Shared by the pasted DEV_ONLY token and the OIDC sign-in: the host decides what the token is worth. */
async function connectWithToken(token: string): Promise<void> {
  try { client = new ObservingClient({ baseUrl: origin, bearerToken: () => bearerToken ?? "" }, observeHead); }
  catch (error) { announce(errorMessage(error), "error"); return; }
  bearerToken = token;
  tokenInput.value = "";
  tokenInput.disabled = true;
  connectButton!.disabled = true;
  oidcButton.disabled = true;
  forgetButton.disabled = false;
  announce("Reading DEV_ONLY host context…");
  try {
    context = await client.getContext();
    renderContext(context);
    setConnected(true);
    reviewerPanel.hidden = false;
    reviewerRoot.dispatchEvent(new CustomEvent<DevProjectOutputsPort | null>("media-dev-reviewer", {
      detail: createDevProjectOutputsClient({ origin, bearerToken: () => bearerToken ?? "", principalId: context.principalId }),
    }));
    announce(`Connected to the local host. Scope: ${context.scope}.`, "success");
    projectTitleInput.focus();
  } catch (error) { announce(errorMessage(error), "error"); }
}

// Optional OIDC sign-in, shown only when an issuer and client id are configured at build/dev-server start.
const oidcConfig = (() => {
  try { return readOidcConfig(import.meta.env, window.location); }
  catch (error) { announce(errorMessage(error), "error"); return null; }
})();
if (oidcConfig) {
  oidcButton.hidden = false;
  byId<HTMLParagraphElement>("oidc-help").hidden = false;
  oidcButton.addEventListener("click", async () => {
    oidcButton.disabled = true;
    announce("Redirecting to the identity provider…");
    try { window.location.assign(await beginLogin(oidcConfig, browserDeps())); }
    catch (error) { oidcButton.disabled = false; announce(errorMessage(error), "error"); }
  });
  if (isCallback(window.location.search)) {
    const search = window.location.search;
    // The authorization response is single-use: remove it from the address bar and history immediately.
    window.history.replaceState(null, "", window.location.pathname);
    completeLogin(oidcConfig, search, browserDeps())
      .then((session) => connectWithToken(session.accessToken))
      .catch((error) => announce(error instanceof OidcLoginError ? error.message : errorMessage(error), "error"));
  }
}

forgetButton.addEventListener("click", () => {
  bearerToken = null;
  client = null;
  context = null;
  lastCreateRequest = null;
  unresolvedProjectCreate = false;
  openProjectIdInput.value = "";
  workspaceRoot.dispatchEvent(new CustomEvent<WorkspaceDetail | null>("media-dev-project-timeline", { detail: null }));
  workspacePanel.hidden = true;
  openProject = null;
  showRestorePanel();
  reviewerPanel.hidden = true;
  reviewerRoot.dispatchEvent(new CustomEvent<DevProjectOutputsPort | null>("media-dev-reviewer", { detail: null }));
  tokenInput.value = "";
  tokenInput.disabled = false;
  connectButton.disabled = false;
  oidcButton.disabled = false;
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
    hideReviewerPanel();
    rememberOpenedWorkspace(result.project, exactRevision.revision);
    workspaceRoot.dispatchEvent(new CustomEvent<WorkspaceDetail>("media-dev-project-timeline", {
      detail: { client, project: result.project, revision: exactRevision.revision, outputs: createDevProjectOutputsClient({ origin, bearerToken: () => bearerToken ?? "", principalId: context?.principalId }), principalId: context?.principalId ?? "" },
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
    hideReviewerPanel();
    rememberOpenedWorkspace(project, currentRevision);
    workspaceRoot.dispatchEvent(new CustomEvent<WorkspaceDetail>("media-dev-project-timeline", {
      detail: { client, project, revision: currentRevision, outputs: createDevProjectOutputsClient({ origin, bearerToken: () => bearerToken ?? "", principalId: context?.principalId }), principalId: context?.principalId ?? "" },
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

/** The project workspace already carries the review section; never mount two (duplicate ids and controls). */
function hideReviewerPanel(): void {
  reviewerPanel.hidden = true;
  reviewerRoot.dispatchEvent(new CustomEvent<DevProjectOutputsPort | null>("media-dev-reviewer", { detail: null }));
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
