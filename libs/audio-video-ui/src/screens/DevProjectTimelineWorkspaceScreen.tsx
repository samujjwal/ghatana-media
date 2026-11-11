import React from "react";
import type {
  DevOwnedArtifact,
  DevProject,
  DevProjectRevision,
  DevRevisionRead,
  DevTimelineClip,
  DevTimelineEdit,
  MediaDevProjectTimelineClient,
} from "@audio-video/client/dev-project-timeline";
import { compareProjectRevisions, type ProjectRevisionComparison } from "./projectTimelineRevisionComparison";

/** Typed loopback development host boundary. */
export type DevProjectTimelineWorkspacePort = Pick<MediaDevProjectTimelineClient,
  "getOwnedArtifact" | "getProject" | "getRevision" | "createTimeline" | "editTimeline" | "restoreRevision">;

export interface DevProjectTimelineWorkspaceScreenProps {
  readonly client: DevProjectTimelineWorkspacePort;
  readonly project: DevProject;
  readonly revision: DevProjectRevision;
}

type PendingMutation =
  | { readonly kind: "timeline"; readonly timelineId: string; readonly baseRevisionId: string }
  | { readonly kind: "edit"; readonly timelineId: string; readonly edit: DevTimelineEdit; readonly baseRevisionId: string }
  | { readonly kind: "restore"; readonly targetRevisionId: string; readonly baseRevisionId: string };
type PendingOperation = PendingMutation | { readonly kind: "reopen"; readonly baseRevisionId: string };
type ViewState =
  | { readonly kind: "ready"; readonly project: DevProject; readonly revision: DevProjectRevision; readonly message: string }
  | { readonly kind: "busy"; readonly project: DevProject; readonly revision: DevProjectRevision; readonly message: string }
  | { readonly kind: "unknown"; readonly project: DevProject; readonly revision: DevProjectRevision; readonly pending: PendingOperation; readonly retryConfirmed: boolean; readonly message: string };
type ObservedRevision = { readonly scopeKey: string; readonly revision: DevProjectRevision };
type ObservedArtifact = { readonly scopeKey: string; readonly artifact: DevOwnedArtifact };
const ID_PATTERN = "[A-Za-z0-9][A-Za-z0-9._:\\x2d]{0,127}";
const ID = new RegExp(`^${ID_PATTERN}$`, "u");
const DECIMAL = /^(0|[1-9][0-9]*)$/u;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const isCurrentHead = (project: DevProject, revision: DevProjectRevision): boolean =>
  project.projectId === revision.projectId && project.tenantId === revision.tenantId && project.headRevisionId === revision.revisionId;
const graphFor = (revision: DevProjectRevision, timelineId: string) =>
  revision.timelines.find((timeline) => timeline.graph.timelineId === timelineId)?.graph;
const stableJson = (value: unknown): string => JSON.stringify(value, (_key, nested: unknown) => {
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
  return Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
});
const sameGraph = (left: DevProjectRevision, right: DevProjectRevision): boolean =>
  stableJson(left.timelines.map((snapshot) => snapshot.graph)) === stableJson(right.timelines.map((snapshot) => snapshot.graph));
function timeOrder(left: DevTimelineClip["sourceIn"], right: DevTimelineClip["sourceIn"]): number {
  if (left.clock !== right.clock) throw new Error("Cannot compare different timeline clock domains.");
  const leftValue = BigInt(left.ticks) * BigInt(left.rateDenominator) * BigInt(right.rateNumerator);
  const rightValue = BigInt(right.ticks) * BigInt(right.rateDenominator) * BigInt(left.rateNumerator);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
function sameClip(left: DevTimelineClip, right: DevTimelineClip): boolean {
  return left.clipId === right.clipId && left.sceneId === right.sceneId && left.trackId === right.trackId
    && left.source.artifactId === right.source.artifactId
    && left.source.artifactVersionId === right.source.artifactVersionId
    && timeOrder(left.sourceIn, right.sourceIn) === 0
    && timeOrder(left.sourceOut, right.sourceOut) === 0
    && timeOrder(left.storyStart, right.storyStart) === 0
    && timeOrder(left.storyDuration, right.storyDuration) === 0;
}
function int64(value: string, positive = false): boolean {
  if (!DECIMAL.test(value)) return false;
  const parsed = BigInt(value);
  return parsed <= MAX_INT64 && (!positive || parsed > 0n);
}
const clientKeys = new WeakMap<object, number>();
let nextClientKey = 1;
function clientKey(client: DevProjectTimelineWorkspacePort): number {
  let key = clientKeys.get(client as object);
  if (key === undefined) { key = nextClientKey++; clientKeys.set(client as object, key); }
  return key;
}

/** Reusable local workspace; its route and all host effects remain DEV_ONLY/NOT_ADMITTED. */
export function DevProjectTimelineWorkspaceScreen({ client, project, revision }: DevProjectTimelineWorkspaceScreenProps): React.ReactElement {
  return <DevProjectTimelineWorkspaceInstance key={`${clientKey(client)}:${project.tenantId}:${project.projectId}`} client={client} project={project} revision={revision} />;
}

function DevProjectTimelineWorkspaceInstance({ client, project, revision }: DevProjectTimelineWorkspaceScreenProps): React.ReactElement {
  const scopeKey = `${project.tenantId}\u0000${project.projectId}`;
  const initial: ViewState = isCurrentHead(project, revision)
    ? { kind: "ready", project, revision, message: "Project head observed." }
    : { kind: "unknown", project, revision, pending: { kind: "reopen", baseRevisionId: revision.revisionId }, retryConfirmed: false, message: "Project and revision identities do not match. Reopen the project head before editing." };
  const [record, setRecord] = React.useState<{ readonly scopeKey: string; readonly client: DevProjectTimelineWorkspacePort; readonly view: ViewState }>(
    { scopeKey, client, view: initial },
  );
  const view = record.scopeKey === scopeKey && record.client === client ? record.view : initial;
  const [observedRecord, setObservedRecord] = React.useState<ObservedRevision | null>(null);
  const observedRevision = observedRecord?.scopeKey === scopeKey ? observedRecord.revision : null;
  const [timelineId, setTimelineId] = React.useState("");
  const [activeTimelineId, setActiveTimelineId] = React.useState<string | null>(revision.timelines[0]?.graph.timelineId ?? null);
  const [sceneId, setSceneId] = React.useState("");
  const [sceneOrder, setSceneOrder] = React.useState("0");
  const [trackId, setTrackId] = React.useState("");
  const [trackSceneId, setTrackSceneId] = React.useState("");
  const [trackKind, setTrackKind] = React.useState<"VIDEO" | "AUDIO" | "CAPTION" | "OVERLAY">("VIDEO");
  const [trackOrder, setTrackOrder] = React.useState("0");
  const [removeSceneId, setRemoveSceneId] = React.useState("");
  const [removeTrackId, setRemoveTrackId] = React.useState("");
  const [sourceArtifactLookupId, setSourceArtifactLookupId] = React.useState("");
  const [observedArtifactRecord, setObservedArtifactRecord] = React.useState<ObservedArtifact | null>(null);
  const observedArtifact = observedArtifactRecord?.scopeKey === scopeKey ? observedArtifactRecord.artifact : null;
  const [clipId, setClipId] = React.useState("");
  const [clipTrackId, setClipTrackId] = React.useState("");
  const [sourceInTicks, setSourceInTicks] = React.useState("0");
  const [sourceOutTicks, setSourceOutTicks] = React.useState("");
  const [sourceRateNumerator, setSourceRateNumerator] = React.useState("");
  const [sourceRateDenominator, setSourceRateDenominator] = React.useState("1");
  const [storyStartTicks, setStoryStartTicks] = React.useState("0");
  const [storyDurationTicks, setStoryDurationTicks] = React.useState("");
  const [storyRateNumerator, setStoryRateNumerator] = React.useState("");
  const [storyRateDenominator, setStoryRateDenominator] = React.useState("1");
  const [removeClipId, setRemoveClipId] = React.useState("");
  const [revisionId, setRevisionId] = React.useState("");
  const [readbackRecord, setReadbackRecord] = React.useState<ObservedRevision | null>(null);
  const [readbackKind, setReadbackKind] = React.useState<"revision" | "project-head">("revision");
  const [comparison, setComparison] = React.useState<ProjectRevisionComparison | null>(null);
  const readback = readbackRecord?.scopeKey === scopeKey ? readbackRecord.revision : null;
  const setReadback = (value: DevProjectRevision | null): void => {
    setReadbackRecord(value ? { scopeKey, revision: value } : null);
    setReadbackKind("revision");
  };
  const busy = view.kind === "busy";
  const locked = busy || view.kind === "unknown";
  const selectedTimelineId = activeTimelineId && graphFor(view.revision, activeTimelineId)
    ? activeTimelineId : view.revision.timelines[0]?.graph.timelineId ?? null;
  const graph = selectedTimelineId ? graphFor(view.revision, selectedTimelineId) : undefined;

  React.useEffect(() => {
    setObservedRecord(null);
    setComparison(null);
    setReadback(null);
    setRevisionId("");
    setTimelineId("");
    setActiveTimelineId(revision.timelines[0]?.graph.timelineId ?? null);
    setSceneId(""); setSceneOrder("0"); setTrackId(""); setTrackSceneId(""); setTrackKind("VIDEO"); setTrackOrder("0");
    setRemoveSceneId(""); setRemoveTrackId("");
    setSourceArtifactLookupId(""); setObservedArtifactRecord(null); setClipId(""); setClipTrackId("");
    setSourceInTicks("0"); setSourceOutTicks(""); setSourceRateNumerator(""); setSourceRateDenominator("1");
    setStoryStartTicks("0"); setStoryDurationTicks(""); setStoryRateNumerator(""); setStoryRateDenominator("1");
    setRemoveClipId("");
  }, [client, project.tenantId, project.projectId]);

  const save = (next: ViewState): void => setRecord({ scopeKey, client, view: next });
  const acceptedProjectRead = async (): Promise<{ project: DevProject; revision: DevProjectRevision }> => {
    const current = await client.getProject(project.projectId);
    if (current.scope !== "DEV_ONLY" || current.project.projectId !== project.projectId
      || current.project.tenantId !== project.tenantId
      || current.project.workspaceId !== project.workspaceId
      || current.project.ownerPrincipalId !== project.ownerPrincipalId
      || !isCurrentHead(current.project, current.currentRevision)) {
      throw new Error("Project head read did not match the requested DEV_ONLY project identity.");
    }
    return { project: current.project, revision: current.currentRevision };
  };
  const setBusy = (message: string): void => save({ kind: "busy", project: view.project, revision: view.revision, message });
  const setReady = (nextProject: DevProject, nextRevision: DevProjectRevision, message: string): void =>
    save({ kind: "ready", project: nextProject, revision: nextRevision, message });

  const mutationResult = async (pending: PendingMutation, result: DevRevisionRead): Promise<{ project: DevProject; revision: DevProjectRevision }> => {
    const next = result.revision;
    if (result.scope !== "DEV_ONLY" || next.projectId !== project.projectId || next.tenantId !== project.tenantId
      || next.parentRevisionId !== pending.baseRevisionId || next.revisionId === pending.baseRevisionId) {
      throw new Error("The mutation response did not match the DEV_ONLY project head request.");
    }
    const current = await acceptedProjectRead();
    if (current.revision.revisionId !== next.revisionId) throw new Error("The committed revision was not observed as the current project head.");
    return current;
  };

  const createTimeline = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const id = timelineId.trim();
    if (!ID.test(id) || locked) return;
    const existing = graphFor(view.revision, id);
    if (existing) { setActiveTimelineId(id); save({ kind: "ready", project: view.project, revision: view.revision, message: `Timeline ${id} is already present in the current owner head ${view.revision.revisionId}; no mutation was sent.` }); return; }
    const pending: PendingMutation = { kind: "timeline", timelineId: id, baseRevisionId: view.revision.revisionId };
    setBusy(`Creating empty timeline ${id}…`);
    try {
      const result = await client.createTimeline(project.projectId, { expectedHeadRevisionId: pending.baseRevisionId, timelineId: id });
      const snapshot = result.revision.timelines.filter((item) => item.graph.timelineId === id);
      if (snapshot.length !== 1 || snapshot[0]!.graph.scenes.length || snapshot[0]!.graph.tracks.length || snapshot[0]!.graph.clips.length) throw new Error("Timeline creation was not empty or unique.");
      const current = await mutationResult(pending, result);
      setActiveTimelineId(id); setReadback(current.revision);
      setReady(current.project, current.revision, `Created empty timeline ${id}; exact revision ${current.revision.revisionId} reopened.`);
    } catch (error) {
      save({ kind: "unknown", project: view.project, revision: view.revision, pending, retryConfirmed: false, message: `OUTCOME_UNKNOWN: the owner head could not confirm timeline ${id}. Reconcile before retrying.` });
    }
  };

  const edit = async (operation: DevTimelineEdit, retryConfirmed = false): Promise<void> => {
    if ((locked && !retryConfirmed) || !selectedTimelineId || !graph) return;
    let problem: string | null = null;
    if (operation.type === "addScene"
      && (graph.scenes.some((scene) => scene.sceneId === operation.sceneId)
        || graph.scenes.some((scene) => scene.order === operation.order))) {
      problem = `Scene ID or order already exists in timeline ${selectedTimelineId}; no mutation was sent.`;
    } else if (operation.type === "addTrack"
      && (!graph.scenes.some((scene) => scene.sceneId === operation.sceneId)
        || graph.tracks.some((track) => track.trackId === operation.trackId)
        || graph.tracks.some((track) => track.sceneId === operation.sceneId && track.order === operation.order))) {
      problem = `Track identity, scene, or order is invalid for timeline ${selectedTimelineId}; no mutation was sent.`;
    } else if (operation.type === "removeScene" && !graph.scenes.some((scene) => scene.sceneId === operation.sceneId)) {
      problem = `Scene ID ${operation.sceneId} is not in the current timeline; no mutation was sent.`;
    } else if (operation.type === "removeScene" && graph.tracks.some((track) => track.sceneId === operation.sceneId)) {
      problem = `Scene ID ${operation.sceneId} still owns tracks. Remove its tracks before removing the scene; no mutation was sent.`;
    } else if (operation.type === "removeTrack" && !graph.tracks.some((track) => track.trackId === operation.trackId)) {
      problem = `Track ID ${operation.trackId} is not in the current timeline; no mutation was sent.`;
    } else if (operation.type === "removeTrack" && graph.clips.some((clip) => clip.trackId === operation.trackId)) {
      problem = `Track ID ${operation.trackId} still owns clips. Remove its clips before removing the track; no mutation was sent.`;
    } else if (operation.type === "putClip") {
      const source = observedArtifact;
      const track = graph.tracks.find((candidate) => candidate.trackId === operation.clip.trackId);
      if (!source || source.tenantId !== project.tenantId || source.principalId !== view.project.ownerPrincipalId
        || source.artifactId !== operation.clip.source.artifactId
        || source.artifactVersionId !== operation.clip.source.artifactVersionId) {
        problem = "Read an exact owner source artifact before adding a clip; no mutation was sent.";
      } else if (!track || track.sceneId !== operation.clip.sceneId
        || !graph.scenes.some((scene) => scene.sceneId === operation.clip.sceneId)) {
        problem = "Clip scene and track must belong to the current timeline; no mutation was sent.";
      }
    } else if (operation.type === "removeClip" && !graph.clips.some((clip) => clip.clipId === operation.clipId)) {
      problem = `Clip ID ${operation.clipId} is not in the current timeline; no mutation was sent.`;
    }
    if (problem) { save({ kind: "ready", project: view.project, revision: view.revision, message: problem }); return; }
    const pending: PendingMutation = { kind: "edit", timelineId: selectedTimelineId, edit: operation, baseRevisionId: view.revision.revisionId };
    setBusy(`Saving ${operation.type}…`);
    try {
      const result = await client.editTimeline(project.projectId, selectedTimelineId, { expectedHeadRevisionId: pending.baseRevisionId, edits: [operation] });
      const current = await mutationResult(pending, result);
      setActiveTimelineId(selectedTimelineId); setReadback(current.revision);
      save({ kind: "ready", project: current.project, revision: current.revision, message: `Committed and reopened ${operation.type} in revision ${current.revision.revisionId}.` });
    } catch (error) {
      if (operation.type === "putClip" && error instanceof Error && "status" in error
        && ((error as { status?: unknown }).status === 403 || (error as { status?: unknown }).status === 404)) {
        setObservedArtifactRecord(null);
        setReady(view.project, view.revision,
          "The exact source artifact version is no longer readable by this DEV_ONLY principal. The project head was not changed; inspect the source again.");
        return;
      }
      save({ kind: "unknown", project: view.project, revision: view.revision, pending, retryConfirmed: false, message: `OUTCOME_UNKNOWN: ${operation.type} may have committed. Reopen the project head before another mutation.` });
    }
  };

  const effectPresent = (pending: PendingMutation, current: DevProjectRevision): boolean => {
    // An effect visible after the base head changed is not enough to attribute
    // it to this request. Another writer may have produced the same graph.
    // Only the exact CAS successor can resolve an ambiguous local dispatch.
    if (current.revisionId === pending.baseRevisionId || current.parentRevisionId !== pending.baseRevisionId) return false;
    if (pending.kind === "timeline") return graphFor(current, pending.timelineId) !== undefined;
    if (pending.kind === "restore") {
      const target = readback?.revisionId === pending.targetRevisionId ? readback : null;
      return target !== null && current.revisionId !== pending.baseRevisionId
        && current.parentRevisionId === pending.baseRevisionId && sameGraph(target, current);
    }
    const currentGraph = graphFor(current, pending.timelineId);
    if (!currentGraph) return false;
    const edit = pending.edit;
    if (edit.type === "addScene") return currentGraph.scenes.some((scene) => scene.sceneId === edit.sceneId && scene.order === edit.order);
    if (edit.type === "removeScene") return !currentGraph.scenes.some((scene) => scene.sceneId === edit.sceneId);
    if (edit.type === "addTrack") return currentGraph.tracks.some((track) => track.trackId === edit.trackId && track.sceneId === edit.sceneId && track.order === edit.order && track.kind === edit.trackKind);
    if (edit.type === "removeTrack") return !currentGraph.tracks.some((track) => track.trackId === edit.trackId);
    if (edit.type === "putClip") return currentGraph.clips.some((clip) => sameClip(clip, edit.clip));
    return !currentGraph.clips.some((clip) => clip.clipId === edit.clipId);
  };

  const reconcile = async (): Promise<void> => {
    if (view.kind !== "unknown") return;
    const pending = view.pending;
    setBusy("Reading the current project head to resolve the outstanding operation…");
    try {
      const current = await acceptedProjectRead();
      if (pending.kind === "reopen") {
        setReadback(current.revision);
        setReadbackKind("project-head");
        setActiveTimelineId(current.revision.timelines[0]?.graph.timelineId ?? null);
        setReady(current.project, current.revision,
          `Reopened project ${project.projectId} at head ${current.revision.revisionId}.`);
        return;
      }
      if (effectPresent(pending, current.revision)) {
        setReadback(current.revision); setActiveTimelineId(pending.kind === "edit" ? pending.timelineId : pending.kind === "timeline" ? pending.timelineId : activeTimelineId);
        const message = pending.kind === "timeline" ? `Timeline outcome reconciled: ${pending.timelineId} is present in owner head ${current.revision.revisionId}.`
          : pending.kind === "edit" ? `Graph edit outcome reconciled: ${pending.edit.type} is present in owner head ${current.revision.revisionId}.`
            : `Restore outcome reconciled: owner head ${current.revision.revisionId} has the exact graph state from ${pending.targetRevisionId}.`;
        setReady(current.project, current.revision, message);
      } else if (current.revision.revisionId === pending.baseRevisionId) {
        const message = pending.kind === "timeline" ? "A retry with this same ID is now available after confirming absence from the owner head."
          : pending.kind === "edit" ? "Owner head confirms this graph edit is absent. You may retry that same action."
            : "Owner head confirms the restore is not present. You may retry the restore.";
        save({ kind: "unknown", project: current.project, revision: current.revision, pending, retryConfirmed: true, message });
      } else {
        save({ kind: "unknown", project: current.project, revision: current.revision, pending, retryConfirmed: false, message: "Owner head changed but the requested effect is not visible. No retry is enabled." });
      }
    } catch {
      save({ kind: "unknown", project: view.project, revision: view.revision, pending, retryConfirmed: false, message: "The current project head is still unavailable. No retry is enabled." });
    }
  };

  const retryPending = async (): Promise<void> => {
    if (view.kind !== "unknown" || !view.retryConfirmed) return;
    const pending = view.pending;
    if (pending.kind === "reopen") return;
    if (pending.kind === "timeline") {
      setTimelineId(pending.timelineId);
      const next: ViewState = { kind: "ready", project: view.project, revision: view.revision, message: "Retrying the timeline ID confirmed absent from the owner head." };
      save(next);
      void client.createTimeline(project.projectId, { expectedHeadRevisionId: view.revision.revisionId, timelineId: pending.timelineId }).then(async (result) => {
        const current = await mutationResult(pending, result);
        setActiveTimelineId(pending.timelineId); setReadback(current.revision);
        setReady(current.project, current.revision, `Created empty timeline ${pending.timelineId}; exact revision ${current.revision.revisionId} reopened.`);
      }).catch(() => save({ kind: "unknown", project: view.project, revision: view.revision, pending, retryConfirmed: false, message: "OUTCOME_UNKNOWN: retry remains unresolved. Reconcile before another mutation." }));
    } else if (pending.kind === "edit") {
      setReady(view.project, view.revision, "Retrying graph edit after owner-head absence was confirmed.");
      await edit(pending.edit, true);
    } else {
      setReady(view.project, view.revision, "Retrying restore after owner-head absence was confirmed.");
      await restoreObserved(pending.targetRevisionId);
    }
  };

  const reopen = async (): Promise<void> => {
    if (busy) return;
    if (view.kind === "unknown") { await reconcile(); return; }
    setBusy("Reopening current project head…");
    try {
      const current = await acceptedProjectRead(); setReadback(current.revision);
      setReadbackKind("project-head");
      setReady(current.project, current.revision, `Reopened project ${project.projectId} at head ${current.revision.revisionId}.`);
    } catch { save({ kind: "unknown", project: view.project, revision: view.revision, pending: { kind: "reopen", baseRevisionId: view.revision.revisionId }, retryConfirmed: false, message: "Project head is unavailable or has a mismatched identity. Read the current project head before editing." }); }
  };

  const readExactRevision = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const id = revisionId.trim();
    if (!ID.test(id) || locked) return;
    setBusy(`Reading exact revision ${id}…`);
    try {
      const result = await client.getRevision(project.projectId, id);
      if (result.scope !== "DEV_ONLY" || result.revision.projectId !== project.projectId || result.revision.tenantId !== project.tenantId || result.revision.revisionId !== id) throw new Error("Exact revision scope mismatch.");
      setObservedRecord({ scopeKey, revision: result.revision }); setReadback(result.revision);
      setComparison(null);
      setReady(view.project, view.revision, `Read exact revision ${id} from project ${project.projectId}.`);
    } catch { setObservedRecord(null); setReady(view.project, view.revision, `Exact revision ${id} is unavailable or could not be verified.`); }
  };

  const readSourceArtifact = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const id = sourceArtifactLookupId.trim();
    if (!ID.test(id) || locked) return;
    setObservedArtifactRecord(null);
    setBusy(`Reading exact owner source artifact ${id}…`);
    try {
      const artifact = await client.getOwnedArtifact(id);
      if (artifact.tenantId !== project.tenantId || artifact.principalId !== view.project.ownerPrincipalId
        || artifact.artifactId !== id || artifact.artifactVersionId !== `sha256:${artifact.sha256}`) {
        throw new Error("Source artifact identity did not match the DEV_ONLY project owner.");
      }
      setObservedArtifactRecord({ scopeKey, artifact });
      setReady(view.project, view.revision,
        `Read exact owner artifact ${artifact.artifactId} at immutable version ${artifact.artifactVersionId}.`);
    } catch (error) {
      const denied = error instanceof Error && "code" in error
        && (error as { code?: unknown }).code === "ARTIFACT_READ_PERMISSION_REQUIRED";
      setReady(view.project, view.revision, denied
        ? "Source artifact inspection is not admitted by the verified DEV_ONLY host context."
        : `Exact source artifact ${id} is unavailable to this DEV_ONLY project owner.`);
    }
  };

  const restoreObserved = async (targetRevisionId = observedRevision?.revisionId): Promise<void> => {
    if (!targetRevisionId || busy) return;
    const target = targetRevisionId === observedRevision?.revisionId ? observedRevision : null;
    if (!target) return;
    let pending: PendingMutation = { kind: "restore", targetRevisionId, baseRevisionId: view.revision.revisionId };
    setBusy(`Restoring exact revision ${targetRevisionId} as a successor…`);
    try {
      const current = await acceptedProjectRead();
      pending = { kind: "restore", targetRevisionId, baseRevisionId: current.revision.revisionId };
      const result = await client.restoreRevision(project.projectId, { expectedHeadRevisionId: current.revision.revisionId, targetRevisionId });
      const restored = await mutationResult(pending, result);
      setReadback(restored.revision); setObservedRecord(null);
      setReady(restored.project, restored.revision, `Restored exact graph state from ${targetRevisionId} as new head ${restored.revision.revisionId}; prior revisions remain available.`);
    } catch {
      save({ kind: "unknown", project: view.project, revision: view.revision, pending, retryConfirmed: false, message: `OUTCOME_UNKNOWN: restore is still unresolved for ${targetRevisionId}. Reconcile before retrying.` });
    }
  };

  const compareObserved = (): void => {
    if (!observedRevision) return;
    try {
      setComparison(compareProjectRevisions(observedRevision, view.revision));
    } catch {
      setComparison(null);
    }
  };

  const selectedSceneOptions = graph?.scenes ?? [];
  const selectedTrackOptions = graph?.tracks ?? [];
  const selectedClipOptions = graph?.clips ?? [];
  React.useEffect(() => {
    const sceneIds = selectedSceneOptions.map((scene) => String(scene.sceneId));
    const trackIds = selectedTrackOptions.map((track) => String(track.trackId));
    const clipIds = selectedClipOptions.map((clip) => clip.clipId);
    setTrackSceneId((current) => sceneIds.includes(current) ? current : sceneIds[0] ?? "");
    setRemoveSceneId((current) => sceneIds.includes(current) ? current : sceneIds[0] ?? "");
    setRemoveTrackId((current) => trackIds.includes(current) ? current : trackIds[0] ?? "");
    setClipTrackId((current) => trackIds.includes(current) ? current : trackIds[0] ?? "");
    setRemoveClipId((current) => clipIds.includes(current) ? current : clipIds[0] ?? "");
  }, [scopeKey, selectedTimelineId, graph]);
  const zeroOrder = (raw: string): number | null => /^\d+$/u.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) <= 2_147_483_647 ? Number(raw) : null;
  const createTimelineEnabled = !locked && ID.test(timelineId.trim());
  const addSceneEnabled = !locked && Boolean(graph) && ID.test(sceneId.trim()) && zeroOrder(sceneOrder) !== null;
  const addTrackEnabled = !locked && Boolean(graph) && ID.test(trackId.trim())
    && selectedSceneOptions.some((scene) => String(scene.sceneId) === trackSceneId) && zeroOrder(trackOrder) !== null;
  const clipTrack = selectedTrackOptions.find((track) => String(track.trackId) === clipTrackId);
  const sourceRangeValid = int64(sourceInTicks) && int64(sourceOutTicks) && BigInt(sourceOutTicks) > BigInt(sourceInTicks);
  const sourceRateValid = int64(sourceRateNumerator, true) && int64(sourceRateDenominator, true);
  const storyStartValid = int64(storyStartTicks);
  const storyDurationValid = int64(storyDurationTicks, true);
  const storyRateValid = int64(storyRateNumerator, true) && int64(storyRateDenominator, true);
  const storyEndValid = storyStartValid && storyDurationValid
    && BigInt(storyStartTicks) + BigInt(storyDurationTicks) <= MAX_INT64;
  const clipDraft: DevTimelineClip | null = observedArtifact && graph && clipTrack && ID.test(clipId.trim())
    && sourceRangeValid && sourceRateValid && storyEndValid && storyRateValid
    ? {
      clipId: clipId.trim(), sceneId: String(clipTrack.sceneId), trackId: String(clipTrack.trackId),
      source: { artifactId: observedArtifact.artifactId, artifactVersionId: observedArtifact.artifactVersionId },
      sourceIn: { ticks: sourceInTicks, rateNumerator: sourceRateNumerator, rateDenominator: sourceRateDenominator, clock: "SOURCE_PRESENTATION" },
      sourceOut: { ticks: sourceOutTicks, rateNumerator: sourceRateNumerator, rateDenominator: sourceRateDenominator, clock: "SOURCE_PRESENTATION" },
      storyStart: { ticks: storyStartTicks, rateNumerator: storyRateNumerator, rateDenominator: storyRateDenominator, clock: "STORY" },
      storyDuration: { ticks: storyDurationTicks, rateNumerator: storyRateNumerator, rateDenominator: storyRateDenominator, clock: "STORY" },
    }
    : null;
  const removeSceneEnabled = !locked && selectedSceneOptions.some((scene) => String(scene.sceneId) === removeSceneId);
  const removeTrackEnabled = !locked && selectedTrackOptions.some((track) => String(track.trackId) === removeTrackId);
  const removeClipEnabled = !locked && selectedClipOptions.some((clip) => clip.clipId === removeClipId);

  return <section className="media-screen-body" aria-labelledby="dev-timeline-workspace-title">
    <aside role="note" aria-label="Development scope"><strong>DEV_ONLY · NOT_ADMITTED</strong><p>Local development data only. This screen does not authenticate through Shared or establish workspace membership or production authority.</p></aside>
    <header><h2 id="dev-timeline-workspace-title">Project timeline workspace</h2><p>Timelines are empty when first added. Each timeline edit or restore advances one project head revision.</p></header>
    <dl>
      <div><dt>Project</dt><dd>{view.project.title} · <code>{view.project.projectId}</code></dd></div>
      <div><dt>Project head</dt><dd aria-label="Project head revision"><code>{view.project.headRevisionId}</code></dd></div>
      <div><dt>Displayed revision</dt><dd aria-label="Displayed project revision"><code>{view.revision.revisionId}</code></dd></div>
      <div><dt>Timelines in this revision</dt><dd>{view.revision.timelines.length}</dd></div>
    </dl>
    <section aria-labelledby="render-availability-title" data-engine-state="UNAVAILABLE">
      <h3 id="render-availability-title">Render engine unavailable</h3>
      <p>Rendering is not available in this DEV_ONLY workspace. No render request has been submitted and no output is implied.</p>
    </section>
    <p id="workspace-status" role="status" aria-live="polite" aria-atomic="true" aria-busy={busy} data-state={view.kind}>{busy ? view.message : view.message}</p>
    {view.kind === "unknown" && <div>
      <button type="button" onClick={() => void reconcile()} disabled={busy}>
        {view.pending.kind === "reopen" ? "Read current project head" : "Reconcile timeline outcome"}
      </button>
      {view.retryConfirmed && view.pending.kind !== "reopen" && <button type="button" onClick={() => void retryPending()} disabled={busy}>Retry after absence confirmed</button>}
    </div>}
    <form id="timeline-form" onSubmit={(event) => void createTimeline(event)}>
      <label htmlFor="timeline-id">Timeline ID</label><input id="timeline-id" value={timelineId} onChange={(event) => setTimelineId(event.currentTarget.value)} required pattern={ID_PATTERN} disabled={locked} />
      <button type="submit" disabled={!createTimelineEnabled}>Create timeline</button>
    </form>
    <section aria-labelledby="timeline-list-title"><h3 id="timeline-list-title">Timelines in the current revision</h3>
      {view.revision.timelines.length === 0 ? <p>No timelines yet.</p> : <ul>{view.revision.timelines.map((item) => <li key={item.graph.timelineId}>
        <button type="button" aria-pressed={selectedTimelineId === item.graph.timelineId} onClick={() => setActiveTimelineId(item.graph.timelineId)} disabled={locked}>{item.graph.timelineId}</button>
        <span> · semantic version <code>{item.semanticVersionId}</code> · {item.graph.scenes.length} scenes, {item.graph.tracks.length} tracks, {item.graph.clips.length} clips</span>
      </li>)}</ul>}
    </section>
    {graph && selectedTimelineId && <section id="graph-editor" aria-labelledby="graph-editor-title"><h3 id="graph-editor-title">Edit timeline content · {selectedTimelineId}</h3>
      <form id="scene-form" onSubmit={(event) => { event.preventDefault(); const order = zeroOrder(sceneOrder); if (order !== null) void edit({ type: "addScene", sceneId: sceneId.trim(), order }); }}>
        <label htmlFor="scene-id">New scene ID</label><input id="scene-id" value={sceneId} onChange={(event) => setSceneId(event.currentTarget.value)} required pattern={ID_PATTERN} disabled={locked} />
        <label htmlFor="scene-order">Scene order</label><input id="scene-order" type="number" min="0" max="2147483647" step="1" value={sceneOrder} onChange={(event) => setSceneOrder(event.currentTarget.value)} required disabled={locked} />
        <button type="submit" disabled={!addSceneEnabled}>Add scene</button>
      </form>
      <form id="track-form" onSubmit={(event) => { event.preventDefault(); const order = zeroOrder(trackOrder); if (order !== null) void edit({ type: "addTrack", trackId: trackId.trim(), sceneId: trackSceneId.trim(), trackKind, order }); }}>
        <label htmlFor="track-id">New track ID</label><input id="track-id" value={trackId} onChange={(event) => setTrackId(event.currentTarget.value)} required pattern={ID_PATTERN} disabled={locked} />
        <fieldset aria-labelledby="track-scene-legend">
          <legend id="track-scene-legend">Parent scene ID</legend>
          {selectedSceneOptions.length === 0 ? <p>No scenes in this timeline yet.</p> : selectedSceneOptions.map((scene) => <label key={String(scene.sceneId)}>
            <input type="radio" name="track-parent-scene" value={String(scene.sceneId)} checked={trackSceneId === String(scene.sceneId)} onChange={(event) => setTrackSceneId(event.currentTarget.value)} required disabled={locked} />
            {String(scene.sceneId)}
          </label>)}
        </fieldset>
        <fieldset aria-labelledby="track-kind-legend">
          <legend id="track-kind-legend">Track kind</legend>
          {(["VIDEO", "AUDIO", "CAPTION", "OVERLAY"] as const).map((kind) => <label key={kind}>
            <input type="radio" name="track-kind" value={kind} checked={trackKind === kind} onChange={(event) => setTrackKind(event.currentTarget.value as typeof trackKind)} disabled={locked} />
            {kind.charAt(0) + kind.slice(1).toLowerCase()}
          </label>)}
        </fieldset>
        <label htmlFor="track-order">Order within scene</label><input id="track-order" type="number" min="0" max="2147483647" step="1" value={trackOrder} onChange={(event) => setTrackOrder(event.currentTarget.value)} required disabled={locked} />
        <button type="submit" disabled={!addTrackEnabled}>Add track</button>
      </form>
      <section aria-labelledby="clip-editor-title">
        <h4 id="clip-editor-title">Attach an exact source version</h4>
        <p>Adding a clip stores an owner-readable artifact version and declared rational source and story times. This DEV_ONLY editor does not verify decoder clock mapping, current rights, or render output; overlap and transition behavior are not defined here.</p>
        <form id="source-artifact-form" onSubmit={(event) => void readSourceArtifact(event)}>
          <label htmlFor="source-artifact-id">Source artifact ID to inspect</label>
          <input id="source-artifact-id" value={sourceArtifactLookupId}
            onChange={(event) => { setSourceArtifactLookupId(event.currentTarget.value); setObservedArtifactRecord(null); }}
            required pattern={ID_PATTERN} disabled={locked} />
          <button type="submit" disabled={locked || !ID.test(sourceArtifactLookupId.trim())}>Read source artifact</button>
        </form>
        {observedArtifact && <p aria-label="Inspected source artifact">
          {observedArtifact.fileName} · {observedArtifact.contentType} · <code>{observedArtifact.artifactId}</code> · immutable version <code>{observedArtifact.artifactVersionId}</code>
        </p>}
        <form id="clip-form" onSubmit={(event) => { event.preventDefault(); if (clipDraft) void edit({ type: "putClip", clip: clipDraft }); }}>
          <label htmlFor="clip-id">Clip ID</label>
          <input id="clip-id" value={clipId} onChange={(event) => setClipId(event.currentTarget.value)} required
            pattern={ID_PATTERN} disabled={locked} />
          <fieldset aria-labelledby="clip-track-legend">
            <legend id="clip-track-legend">Clip track</legend>
            {selectedTrackOptions.length === 0 ? <p>Add a track before attaching a clip.</p> : selectedTrackOptions.map((track) => <label key={String(track.trackId)}>
              <input type="radio" name="clip-track-id" value={String(track.trackId)}
                checked={clipTrackId === String(track.trackId)} onChange={(event) => setClipTrackId(event.currentTarget.value)}
                required disabled={locked} />
              {String(track.trackId)} · {String(track.kind)} · {String(track.sceneId)}
            </label>)}
          </fieldset>
          <fieldset aria-labelledby="source-time-legend">
            <legend id="source-time-legend">Declared source presentation interval</legend>
            <label htmlFor="source-in-ticks">Source in ticks</label>
            <input id="source-in-ticks" type="text" inputMode="numeric" pattern="(0|[1-9][0-9]*)" maxLength={19}
              value={sourceInTicks} onChange={(event) => setSourceInTicks(event.currentTarget.value)} required disabled={locked} />
            <label htmlFor="source-out-ticks">Source out ticks</label>
            <input id="source-out-ticks" type="text" inputMode="numeric" pattern="(0|[1-9][0-9]*)" maxLength={19}
              value={sourceOutTicks} onChange={(event) => setSourceOutTicks(event.currentTarget.value)} required disabled={locked} />
            <label htmlFor="source-rate-numerator">Source rate numerator</label>
            <input id="source-rate-numerator" type="text" inputMode="numeric" pattern="[1-9][0-9]*" maxLength={19}
              value={sourceRateNumerator} onChange={(event) => setSourceRateNumerator(event.currentTarget.value)} required disabled={locked} />
            <label htmlFor="source-rate-denominator">Source rate denominator</label>
            <input id="source-rate-denominator" type="text" inputMode="numeric" pattern="[1-9][0-9]*" maxLength={19}
              value={sourceRateDenominator} onChange={(event) => setSourceRateDenominator(event.currentTarget.value)} required disabled={locked} />
          </fieldset>
          <fieldset aria-labelledby="story-time-legend">
            <legend id="story-time-legend">Declared story interval</legend>
            <label htmlFor="story-start-ticks">Story start ticks</label>
            <input id="story-start-ticks" type="text" inputMode="numeric" pattern="(0|[1-9][0-9]*)" maxLength={19}
              value={storyStartTicks} onChange={(event) => setStoryStartTicks(event.currentTarget.value)} required disabled={locked} />
            <label htmlFor="story-duration-ticks">Story duration ticks</label>
            <input id="story-duration-ticks" type="text" inputMode="numeric" pattern="[1-9][0-9]*" maxLength={19}
              value={storyDurationTicks} onChange={(event) => setStoryDurationTicks(event.currentTarget.value)} required disabled={locked} />
            <label htmlFor="story-rate-numerator">Story rate numerator</label>
            <input id="story-rate-numerator" type="text" inputMode="numeric" pattern="[1-9][0-9]*" maxLength={19}
              value={storyRateNumerator} onChange={(event) => setStoryRateNumerator(event.currentTarget.value)} required disabled={locked} />
            <label htmlFor="story-rate-denominator">Story rate denominator</label>
            <input id="story-rate-denominator" type="text" inputMode="numeric" pattern="[1-9][0-9]*" maxLength={19}
              value={storyRateDenominator} onChange={(event) => setStoryRateDenominator(event.currentTarget.value)} required disabled={locked} />
          </fieldset>
          <button type="submit" disabled={!clipDraft || locked}>Add or update clip reference</button>
        </form>
        {selectedClipOptions.length === 0 ? <p>No clips in this timeline yet.</p> : <ul aria-label="Current timeline clips">
          {selectedClipOptions.map((clip) => <li key={clip.clipId}>
            <code>{clip.clipId}</code> · {clip.source.artifactId}@{clip.source.artifactVersionId} · track {clip.trackId} · source {clip.sourceIn.ticks}/{clip.sourceIn.rateNumerator}:{clip.sourceIn.rateDenominator}–{clip.sourceOut.ticks}/{clip.sourceOut.rateNumerator}:{clip.sourceOut.rateDenominator} · story {clip.storyStart.ticks}/{clip.storyStart.rateNumerator}:{clip.storyStart.rateDenominator}+{clip.storyDuration.ticks}/{clip.storyDuration.rateNumerator}:{clip.storyDuration.rateDenominator}
          </li>)}
        </ul>}
        <form id="remove-clip-form" onSubmit={(event) => { event.preventDefault(); if (removeClipId) void edit({ type: "removeClip", clipId: removeClipId }); }}>
          <fieldset aria-labelledby="remove-clip-legend">
            <legend id="remove-clip-legend">Clip ID to remove</legend>
            {selectedClipOptions.length === 0 ? <p>No clips to remove.</p> : selectedClipOptions.map((clip) => <label key={clip.clipId}>
              <input type="radio" name="remove-clip-id" value={clip.clipId} checked={removeClipId === clip.clipId}
                onChange={(event) => setRemoveClipId(event.currentTarget.value)} required disabled={locked} />
              {clip.clipId}
            </label>)}
          </fieldset>
          <button type="submit" disabled={!removeClipEnabled}>Remove clip</button>
        </form>
      </section>
      <form id="remove-scene-form" onSubmit={(event) => { event.preventDefault(); if (removeSceneId) void edit({ type: "removeScene", sceneId: removeSceneId }); }}>
        <fieldset aria-labelledby="remove-scene-legend">
          <legend id="remove-scene-legend">Scene ID to remove</legend>
          {selectedSceneOptions.length === 0 ? <p>No scenes to remove.</p> : selectedSceneOptions.map((scene) => <label key={String(scene.sceneId)}>
            <input type="radio" name="remove-scene-id" value={String(scene.sceneId)} checked={removeSceneId === String(scene.sceneId)} onChange={(event) => setRemoveSceneId(event.currentTarget.value)} required disabled={locked} />
            {String(scene.sceneId)}
          </label>)}
        </fieldset>
        <button type="submit" disabled={!removeSceneEnabled}>Remove scene</button>
      </form>
      <form id="remove-track-form" onSubmit={(event) => { event.preventDefault(); if (removeTrackId) void edit({ type: "removeTrack", trackId: removeTrackId }); }}>
        <fieldset aria-labelledby="remove-track-legend">
          <legend id="remove-track-legend">Track ID to remove</legend>
          {selectedTrackOptions.length === 0 ? <p>No tracks to remove.</p> : selectedTrackOptions.map((track) => <label key={String(track.trackId)}>
            <input type="radio" name="remove-track-id" value={String(track.trackId)} checked={removeTrackId === String(track.trackId)} onChange={(event) => setRemoveTrackId(event.currentTarget.value)} required disabled={locked} />
            {String(track.trackId)}
          </label>)}
        </fieldset>
        <button type="submit" disabled={!removeTrackEnabled}>Remove track</button>
      </form>
    </section>}
    <button type="button" onClick={() => void reopen()} disabled={busy || view.kind === "unknown"}>Reopen current project</button>
    <form id="revision-form" onSubmit={(event) => void readExactRevision(event)}>
      <label htmlFor="revision-id">Exact revision ID</label><input id="revision-id" value={revisionId} onChange={(event) => setRevisionId(event.currentTarget.value)} required disabled={locked} />
      <button type="submit" disabled={locked || !ID.test(revisionId.trim())}>Read exact revision</button>
    </form>
    {observedRevision && <section aria-labelledby="exact-revision-title"><h3 id="exact-revision-title">Immutable revision readback</h3>
      <p>Read exact revision <code>{observedRevision.revisionId}</code> from project {project.projectId}.</p>
      <p>Comparison reports stored scene, track, and clip reference changes only. It does not evaluate source rights, clock mapping, overlap behavior, or rendered output.</p>
      <button type="button" onClick={compareObserved} disabled={locked}>Compare with displayed revision</button>
    </section>}
    {comparison && <section aria-labelledby="revision-comparison-title" aria-live="polite">
      <h3 id="revision-comparison-title">Exact revision comparison</h3>
      <p>From <code>{comparison.fromRevisionId}</code> to <code>{comparison.toRevisionId}</code></p>
      {comparison.addedTimelineIds.length > 0 && <p>Timelines added: {comparison.addedTimelineIds.join(", ")}</p>}
      {comparison.removedTimelineIds.length > 0 && <p>Timelines removed: {comparison.removedTimelineIds.join(", ")}</p>}
      {comparison.changes.length === 0 && comparison.addedTimelineIds.length === 0 && comparison.removedTimelineIds.length === 0
        ? <p>No stored timeline graph changes.</p>
        : <ul aria-label="Timeline graph changes">{comparison.changes.map((change) => <li key={`${change.timelineId}:${change.kind}:${change.entityId}`}>
          {change.change} {change.kind} <code>{change.entityId}</code> in timeline <code>{change.timelineId}</code>
        </li>)}</ul>}
    </section>}
    <button type="button" onClick={() => void restoreObserved()} disabled={locked || !observedRevision}>Restore as new project head</button>
    <button type="button" onClick={() => readback && document.getElementById("timeline-json")?.scrollIntoView({ block: "nearest" })} disabled={!readback}>Show last revision readback</button>
    <pre id="timeline-json" aria-label="Latest timeline revision JSON" hidden={!readback}>{readback ? JSON.stringify({ scope: "DEV_ONLY", revision: readback }, null, 2) : ""}</pre>
    <pre id="readback-json" aria-label="Latest project revision readback JSON" hidden={!readback}>{readback ? JSON.stringify(readbackKind === "project-head"
      ? { scope: "DEV_ONLY", project: view.project, currentRevision: readback }
      : { scope: "DEV_ONLY", revision: readback }, null, 2) : ""}</pre>
  </section>;
}
