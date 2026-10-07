import React from "react";
import { MediaTaskScreen, type MediaTaskScreenProps } from "./MediaTaskScreen";

export type FirstUseProjectView =
  | "authenticate-and-select-context"
  | "resume-work"
  | "find-projects"
  | "work-in-project"
  | "create-media";

export interface FirstUseProjectProjection {
  readonly view: FirstUseProjectView;
  readonly workspaceName?: string;
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

/** Candidate J-01 screen body. All identity, access, project and action facts come from the host. */
export function FirstUseProjectScreen({ project, onProjectNameDraftChange, actions = [], actionPort, ...flow }: FirstUseProjectScreenProps): React.ReactElement {
  const heading = {
    "authenticate-and-select-context": "Choose your workspace",
    "resume-work": "Your projects",
    "find-projects": "Projects in this workspace",
    "work-in-project": "Project workspace",
    "create-media": "Start a media task",
  }[project.view];
  const createAction = actions.find((action) => action.id === "media.action.create-project");
  const flowActions = actions.filter((action) => action.id !== "media.action.create-project");
  return <MediaTaskScreen {...flow} actions={flowActions} actionPort={actionPort}>
    <section className="media-screen-body" aria-labelledby="first-use-project-title">
      <header>
        <h3 id="first-use-project-title">{heading}</h3>
        {project.workspaceName && <p>Workspace: {project.workspaceName}</p>}
      </header>
      {project.accessState === "loading" && <p role="status">Checking your current access…</p>}
      {project.accessState === "denied" && <p role="status">Workspace access is unavailable. Project data is hidden until access is granted.</p>}
      {project.accessState === "unknown" && <p role="status">Workspace access could not be confirmed. Try checking access again.</p>}
      {project.message && <p role="status">{project.message}</p>}
      {project.returnDestination && <p>Return destination: {project.returnDestination}</p>}
      {project.projectName && <p>Project: <strong>{project.projectName}</strong></p>}
      {(project.view === "resume-work" || project.view === "find-projects") && <>
        {project.projects?.length ? <ul aria-label="Authorized projects">
          {project.projects.map((item) => <li key={item.id}>
            <p>{item.name}</p>
            <p>Project ID: {item.id}{item.updatedAt ? ` · Updated ${item.updatedAt}` : ""}</p>
          </li>)}
        </ul> : project.projects !== undefined && project.projects.length === 0 && project.accessState === "resolved"
          ? <p>No authorized projects are available in this workspace yet.</p>
          : null}
      </>}
      {project.view === "work-in-project" && <p>Project actions and media content are supplied by the active host.</p>}
      {project.view === "create-media" && <p>Choose an available media task from the actions provided for this project.</p>}
      {project.view === "find-projects" && <section aria-labelledby="create-project-title">
        <h4 id="create-project-title">Create an empty project</h4>
        <label htmlFor="new-project-name">Project name</label>
        <input id="new-project-name" type="text" value={project.projectNameDraft ?? ""}
          disabled={!onProjectNameDraftChange || !createAction?.enabled}
          onChange={(event) => onProjectNameDraftChange?.(event.currentTarget.value)} />
        <button type="button" disabled={!createAction?.enabled} onClick={() => {
          const name = project.projectNameDraft;
          void actionPort.invoke("media.action.create-project", name ? { name } : {});
        }}>{createAction?.label ?? "Create project"}</button>
        {createAction?.disabledReason && <p>{createAction.disabledReason}</p>}
      </section>}
    </section>
  </MediaTaskScreen>;
}
