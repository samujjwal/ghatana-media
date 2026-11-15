import type { DevProject, DevProjectRevision } from "@audio-video/client/dev-project-timeline";

/**
 * A small, NON-secret pointer to the last opened project so the page can show its encrypted offline drafts after a
 * reload while the host (and the page's own bearer token) is unreachable. It never contains a token or a draft: only
 * identifiers and the last observed head. Drafts themselves live encrypted in IndexedDB; the key is a non-extractable
 * browser-held WebCrypto key. Replay always needs a fresh token and a fresh host read.
 */
export interface OfflineWorkspacePointer {
  readonly v: 1;
  readonly principalId: string;
  readonly project: DevProject;
  readonly timelineIds: readonly string[];
}

export const OFFLINE_WORKSPACE_KEY = "ghatana-media-dev-offline-workspace-v1";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 400;

export function readOfflineWorkspacePointer(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): OfflineWorkspacePointer | null {
  try {
    const raw = storage?.getItem(OFFLINE_WORKSPACE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<OfflineWorkspacePointer>;
    const project = value.project as Partial<DevProject> | undefined;
    if (value.v !== 1 || !text(value.principalId) || !project || !text(project.tenantId) || !ID.test(String(project.projectId))
      || !text(project.workspaceId) || !text(project.ownerPrincipalId) || typeof project.title !== "string"
      || !ID.test(String(project.headRevisionId)) || !Array.isArray(value.timelineIds) || !value.timelineIds.every((id) => ID.test(String(id)))) return null;
    return value as OfflineWorkspacePointer;
  } catch { return null; }
}

export function writeOfflineWorkspacePointer(pointer: OfflineWorkspacePointer, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try { storage?.setItem(OFFLINE_WORKSPACE_KEY, JSON.stringify(pointer)); } catch { /* storage unavailable: the pointer is a convenience */ }
}

/** The revision stub the offline panel needs (timeline choices and the base head). Contains no timeline content. */
export function restoredRevision(pointer: OfflineWorkspacePointer): DevProjectRevision {
  return {
    tenantId: pointer.project.tenantId, projectId: pointer.project.projectId, revisionId: pointer.project.headRevisionId,
    parentRevisionId: null,
    timelines: pointer.timelineIds.map((timelineId) => ({ semanticVersionId: "restored", graph: { timelineId, scenes: [], tracks: [], clips: [] } })),
  };
}

function safeStorage(): Storage | undefined { try { return globalThis.localStorage; } catch { return undefined; } }
