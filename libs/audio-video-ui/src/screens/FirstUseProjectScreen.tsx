import React from "react";
import { MediaTaskScreen, type MediaScreenAction, type MediaTaskScreenProps } from "./MediaTaskScreen";
import { createMediaActionDispatchGuard } from "./MediaActionDispatchGuard";
import { EmptyState } from "../foundations";
import { MediaActionFeedback, type MediaActionFeedbackValue } from "../components/MediaActionFeedback";
import type { MediaActionDispatchResult } from "../ports";

export type FirstUseProjectView =
  | "authenticate-and-select-context"
  | "resume-work"
  | "find-projects"
  | "work-in-project"
  | "create-media";

export interface FirstUseProjectProjection {
  readonly view: FirstUseProjectView;
  readonly workspaceName?: string;
  /** Opaque workspace identity from the authenticated host's selected context. */
  readonly selectedAuthorizedWorkspaceId?: string;
  readonly projectName?: string;
  readonly projectNameDraft?: string;
  readonly projects?: readonly { readonly id: string; readonly name: string; readonly updatedAt?: string }[];
  readonly message?: string;
  readonly accessState?: "resolved" | "denied" | "unknown" | "loading";
  readonly returnDestination?: string;
}

export interface FirstUseProjectScreenProps extends Omit<MediaTaskScreenProps, "children"> {
  readonly project: FirstUseProjectProjection;
  readonly onProjectNameDraftChange?: (name: string) => void;
}

interface CreateProjectRequest {
  readonly selectedAuthorizedWorkspaceId: string;
  readonly title: string;
  readonly requestId: string;
}

function createProjectRequest(action: MediaScreenAction | undefined): CreateProjectRequest | undefined {
  try {
    if (!action || typeof action !== "object" || !("payload" in action)) return undefined;
    const payload = action.payload;
    if (!payload || typeof payload !== "object") return undefined;
    const keys = Object.keys(payload).sort();
    if (keys.length !== 3 || keys[0] !== "requestId" || keys[1] !== "selectedAuthorizedWorkspaceId" || keys[2] !== "title") return undefined;
    const { selectedAuthorizedWorkspaceId, title, requestId } = payload;
    if (typeof selectedAuthorizedWorkspaceId !== "string" || selectedAuthorizedWorkspaceId.length > 128
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(selectedAuthorizedWorkspaceId)) return undefined;
    if (typeof title !== "string" || [...title].length > 200 || !/\S/.test(title)) return undefined;
    if (typeof requestId !== "string" || requestId.length > 128
      || !/^[A-Za-z0-9][A-Za-z0-9._~:-]*$/.test(requestId)) return undefined;
    return Object.freeze({ selectedAuthorizedWorkspaceId, title, requestId });
  } catch {
    // Malformed host projections fail closed without rendering attacker text.
    return undefined;
  }
}

function safeCreateFeedback(result: MediaActionDispatchResult): MediaActionFeedbackValue {
  switch (result.status) {
    case "intent-accepted":
      return { state: result.status, message: "The project request was accepted as an intent. Project creation is not confirmed." };
    case "local-applied":
      return { state: result.status, message: "The local action was applied. Project creation is not confirmed." };
    case "request-started":
      return { state: result.status, message: "The project request started. Completion remains unobserved." };
    case "request-acknowledged":
      return { state: result.status, message: "The project request was acknowledged. Completion remains unobserved." };
    case "denied":
      return { state: result.status, message: "Project creation was denied." };
    case "unavailable":
      return { state: result.status, message: "Project creation is unavailable." };
    case "failed":
      return { state: result.status, message: "The project request failed. Reconcile the same request before retrying." };
  }
}

/** Candidate J-01 screen body. All identity, access, project and action facts come from the host. */
export function FirstUseProjectScreen({ project, onProjectNameDraftChange, actions = [], actionPort, ...flow }: FirstUseProjectScreenProps): React.ReactElement {
  const [createPending, setCreatePending] = React.useState(false);
  const [createFeedback, setCreateFeedback] = React.useState<MediaActionFeedbackValue | undefined>();
  const actionPortRef = React.useRef(actionPort);
  actionPortRef.current = actionPort;
  const dispatchGuardRef = React.useRef<ReturnType<typeof createMediaActionDispatchGuard> | undefined>(undefined);
  if (!dispatchGuardRef.current) {
    dispatchGuardRef.current = createMediaActionDispatchGuard({
      invoke: async (actionId, payload, context) => {
        const result = await actionPortRef.current.invoke(actionId, payload, context);
        if (actionId === "media.action.create-project"
          && (result.status === "request-started" || result.status === "request-acknowledged")
          && (typeof payload?.requestId !== "string" || result.requestId !== payload.requestId)) {
          throw new Error("The host did not preserve the original project request identity.");
        }
        return result;
      },
    }, (actionId, pending) => {
      if (actionId === "media.action.create-project") setCreatePending(pending);
    });
  }
  const dispatchGuard = dispatchGuardRef.current;
  React.useEffect(() => {
    dispatchGuard.observeReconciliations(flow.data.actionReconciliations ?? []);
  }, [dispatchGuard, flow.data.actionReconciliations]);
  const heading = {
    "authenticate-and-select-context": "Choose your workspace",
    "resume-work": "Your projects",
    "find-projects": "Projects in this workspace",
    "work-in-project": "Project workspace",
    "create-media": "Start a media task",
  }[project.view];
  const createAction = actions.find((action) => action.id === "media.action.create-project");
  const request = createProjectRequest(createAction);
  const subjectRefs = Object.freeze([...(createAction?.subjectRefs ?? [])]);
  const createReady = project.accessState === "resolved"
    && Boolean(project.workspaceName?.trim())
    && Boolean(createAction?.enabled)
    && !createAction?.payloadForSelection
    && Boolean(request)
    && request?.selectedAuthorizedWorkspaceId === project.selectedAuthorizedWorkspaceId
    && request?.title === project.projectNameDraft
    && Boolean(subjectRefs?.length && subjectRefs.every((ref) => ref.trim().length > 0));
  const flowActions = actions.filter((action) => action.id !== "media.action.create-project");
  const mayShowProjectData = project.accessState === "resolved";
  return <MediaTaskScreen {...flow} actions={flowActions} actionPort={actionPort}>
    <section className="media-screen-body" aria-labelledby="first-use-project-title">
      <header>
        <h3 id="first-use-project-title">{heading}</h3>
        {mayShowProjectData && project.workspaceName && <p>Workspace: {project.workspaceName}</p>}
      </header>
      {project.accessState === "loading" && <p role="status">Checking your current access…</p>}
      {project.accessState === "denied" && <p role="status">Workspace access is unavailable. Project data is hidden until access is granted.</p>}
      {project.accessState === "unknown" && <p role="status">Workspace access could not be confirmed. Try checking access again.</p>}
      {mayShowProjectData && project.message && <p role="status">{project.message}</p>}
      {mayShowProjectData && project.returnDestination && <p>Return destination: {project.returnDestination}</p>}
      {mayShowProjectData && project.projectName && <p>Project: <strong>{project.projectName}</strong></p>}
      {(project.view === "resume-work" || project.view === "find-projects") && <>
        {mayShowProjectData && project.projects?.length ? <ul aria-label="Authorized projects">
          {project.projects.map((item) => <li key={item.id}>
            <p>{item.name}</p>
            <p>Project ID: {item.id}{item.updatedAt ? ` · Updated ${item.updatedAt}` : ""}</p>
          </li>)}
        </ul> : project.projects !== undefined && project.projects.length === 0 && project.accessState === "resolved"
          ? <EmptyState className="gh-empty-state--panel" title="No authorized projects are available in this workspace yet." />
          : null}
      </>}
      {project.view === "work-in-project" && <p>Project actions and media content are supplied by the active host.</p>}
      {project.view === "create-media" && <p>Choose an available media task from the actions provided for this project.</p>}
      {project.view === "find-projects" && <section aria-labelledby="create-project-title">
        <h4 id="create-project-title">Create an empty project</h4>
        <label htmlFor="new-project-name">Project name</label>
        <input id="new-project-name" className="media-input" type="text" value={project.projectNameDraft ?? ""}
          disabled={dispatchGuard.isInFlight("media.action.create-project") || !onProjectNameDraftChange || !createAction?.enabled}
          onChange={(event) => onProjectNameDraftChange?.(event.currentTarget.value)} />
        {createReady && request && <p>Confirm project creation: “{request.title}” in workspace “{project.workspaceName}”.</p>}
        <button type="button" className="media-action-button media-action-button--primary" disabled={dispatchGuard.isInFlight("media.action.create-project") || !createReady} onClick={() => {
          if (!createReady || !createAction || !request || !subjectRefs || dispatchGuard.isInFlight("media.action.create-project")) return;
          setCreateFeedback({ state: "pending", message: "Requesting project creation; completion remains unknown until exact owner reconciliation." });
          void (async () => {
            try {
              const payload = Object.freeze({
                selectedAuthorizedWorkspaceId: request.selectedAuthorizedWorkspaceId,
                title: request.title,
                requestId: request.requestId,
              });
              const result = await dispatchGuard.actionPort.invoke(createAction.id, payload, { subjectRefs });
              setCreateFeedback(safeCreateFeedback(result));
            } catch {
              setCreateFeedback({ state: "unknown", message: "Request outcome is unknown. Reconcile the exact project request before retrying." });
            }
          })();
        }}>{createPending ? "Waiting for project outcome…" : createAction?.label ?? "Create project"}</button>
        {createFeedback && <MediaActionFeedback value={createFeedback} />}
        {!createReady && <p>Project creation is unavailable until the host confirms the authorized workspace and supplies the exact approved request and reconciliation references.</p>}
      </section>}
    </section>
  </MediaTaskScreen>;
}
