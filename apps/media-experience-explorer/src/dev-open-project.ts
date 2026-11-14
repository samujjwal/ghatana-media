import {
  MediaDevProjectTimelineError,
  type DevProjectContext,
  type DevProjectRead,
  type MediaDevProjectTimelineClient,
} from "@audio-video/client/dev-project-timeline";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type OpenProjectResult =
  | { readonly ok: true; readonly read: DevProjectRead }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Typed, owner-scope-aware wording for the failures an open-by-id can produce. */
export function describeOpenProjectFailure(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof MediaDevProjectTimelineError) {
    if (error.code === "PROJECT_NOT_FOUND" || error.status === 404) {
      return { code: "PROJECT_NOT_FOUND", message: "PROJECT_NOT_FOUND: no project with that id exists in this tenant and owner scope. Nothing was opened." };
    }
    if (error.code === "PROJECT_ACCESS_DENIED" || error.status === 403) {
      return { code: "PROJECT_ACCESS_DENIED", message: "PROJECT_ACCESS_DENIED: this DEV_ONLY principal is not authorized to open that project. Nothing was opened." };
    }
    if (error.code === "OUTCOME_UNKNOWN" || error.code === "TRANSPORT_ERROR") {
      return { code: error.code, message: `${error.code}: the host did not answer; nothing was opened. Try again.` };
    }
    if (error.code === "INVALID_RESPONSE") return { code: error.code, message: `UNKNOWN: ${error.message}` };
    return { code: error.code, message: `${error.code}: ${error.message}` };
  }
  return { code: "UNKNOWN", message: error instanceof Error ? error.message : "UNKNOWN: local Media host request failed." };
}

/**
 * Read an existing project by id (GET /dev/v1/projects/{id}) and accept it only when it belongs to the
 * connected tenant, is DEV_ONLY, and its current revision is exactly its head revision.
 */
export async function openExistingProject(
  client: Pick<MediaDevProjectTimelineClient, "getProject">,
  context: Pick<DevProjectContext, "tenantId">,
  rawProjectId: string,
): Promise<OpenProjectResult> {
  const projectId = rawProjectId.trim();
  if (!OPAQUE_ID.test(projectId)) {
    return { ok: false, code: "INVALID_REQUEST", message: "Enter a project id: 1-128 letters, digits or . _ : -, starting with a letter or digit." };
  }
  try {
    const read = await client.getProject(projectId);
    if (read.scope !== "DEV_ONLY" || read.project.projectId !== projectId || read.project.tenantId !== context.tenantId
      || read.currentRevision.projectId !== projectId || read.currentRevision.revisionId !== read.project.headRevisionId) {
      throw new MediaDevProjectTimelineError("INVALID_RESPONSE", 200, "The host project read did not match the requested project, tenant and exact head revision.");
    }
    return { ok: true, read };
  } catch (error) {
    return { ok: false, ...describeOpenProjectFailure(error) };
  }
}
