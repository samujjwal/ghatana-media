import React from "react";
import type { DevProject, DevProjectRevision, DevTimelineEdit } from "@audio-video/client/dev-project-timeline";
import {
  OfflineTimelineDrafts, isConnectivityFailure,
  type DraftReplayOutcome, type DraftReview, type OfflineDraftsPort, type TimelineDraft,
} from "./offlineTimelineDrafts";

export interface DevOfflineDraftsPanelProps {
  readonly client: OfflineDraftsPort;
  readonly project: DevProject;
  /** Last observed project head; the base revision of drafts captured while offline. */
  readonly revision: DevProjectRevision;
  /** Verified principal from the host context (never derived from the bearer token). */
  readonly principalId: string;
  readonly indexedDB?: IDBFactory;
  readonly crypto?: Crypto;
  readonly newId?: () => string;
}

type Link = "online" | "offline";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function describeEdit(edit: DevTimelineEdit): string {
  switch (edit.type) {
    case "addScene": return `Add scene ${edit.sceneId} (order ${edit.order})`;
    case "removeScene": return `Remove scene ${edit.sceneId}`;
    case "removeClip": return `Remove clip ${edit.clipId}`;
    case "removeTrack": return `Remove track ${edit.trackId}`;
    case "addTrack": return `Add ${edit.trackKind} track ${edit.trackId}`;
    case "putClip": return `Put clip ${edit.clip.clipId}`;
  }
}

function describeOutcome(outcome: DraftReplayOutcome): string {
  switch (outcome.kind) {
    case "APPLIED": return `APPLIED (201): revision ${outcome.revisionId} committed with requestId ${outcome.requestId}.`;
    case "REPLAYED": return `REPLAYED: the same requestId ${outcome.requestId} was accepted again; revision ${outcome.revisionId}.`;
    case "REVISION_CONFLICT": return `REVISION_CONFLICT: this draft was authored on ${outcome.baseRevisionId} but the project head is ${outcome.currentHeadRevisionId}. ${outcome.message}`;
    case "DISCARDED": return `DISCARDED (${outcome.status} ${outcome.reason}): ${outcome.message}`;
    case "OUTCOME_UNKNOWN": return `OUTCOME_UNKNOWN: ${outcome.message}`;
    case "RETRYABLE": return `${outcome.reason}: ${outcome.message}`;
    case "REVIEW_REQUIRED": return `REVIEW_REQUIRED: ${outcome.message}`;
  }
}

/**
 * Offline drafts for the timeline workspace. Drafts are inert, encrypted with a
 * browser-held non-extractable key, and are only ever sent after an explicit
 * per-draft review. Nothing here replays automatically.
 */
export function DevOfflineDraftsPanel(props: DevOfflineDraftsPanelProps): React.ReactElement {
  const { client, project, revision, principalId, indexedDB, crypto, newId } = props;
  const [controller, setController] = React.useState<OfflineTimelineDrafts | null>(null);
  const [fatal, setFatal] = React.useState<string | null>(null);
  const [link, setLink] = React.useState<Link>(() => typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "online");
  const [drafts, setDrafts] = React.useState<readonly TimelineDraft[]>([]);
  const [base, setBase] = React.useState(revision.revisionId);
  const [reviews, setReviews] = React.useState<Readonly<Record<string, DraftReview>>>({});
  const [outcomes, setOutcomes] = React.useState<Readonly<Record<string, DraftReplayOutcome>>>({});
  const [message, setMessage] = React.useState("Offline drafts are stored encrypted in this browser and are never sent automatically.");
  const [busy, setBusy] = React.useState(false);
  // A newly observed head (for example after the workspace reopens the project) becomes the base of later drafts.
  React.useEffect(() => { setBase(revision.revisionId); }, [revision.revisionId]);
  const [timelineId, setTimelineId] = React.useState(revision.timelines[0]?.graph.timelineId ?? "");
  const [kind, setKind] = React.useState<"addScene" | "removeScene" | "removeClip">("addScene");
  const [targetId, setTargetId] = React.useState("");
  const [order, setOrder] = React.useState("0");

  React.useEffect(() => {
    let cancelled = false;
    let opened: OfflineTimelineDrafts | null = null;
    setController(null); setFatal(null); setDrafts([]); setReviews({}); setOutcomes({});
    setBase(revision.revisionId);
    void (async () => {
      try {
        opened = await OfflineTimelineDrafts.open({ scope: { tenantId: project.tenantId, principalId, projectId: project.projectId }, port: client, indexedDB, crypto, newId });
        const existing = await opened.list();
        if (cancelled) { await opened.close(); return; }
        setController(opened); setDrafts(existing);
        if (existing.length > 0) setMessage(`${existing.length} offline draft(s) restored. Review each draft before it can be sent.`);
      } catch (error) {
        if (!cancelled) setFatal(error instanceof Error ? error.message : "Offline drafts are unavailable in this browser.");
      }
    })();
    return () => { cancelled = true; void opened?.close(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, project.tenantId, project.projectId, principalId, indexedDB, crypto]);

  React.useEffect(() => {
    const goOffline = (): void => { setLink("offline"); setMessage("Offline. Edits can be saved as encrypted drafts; none are sent."); };
    const goOnline = (): void => { setLink("online"); setMessage("Back online. Drafts are not sent automatically; use Review and replay on each one."); };
    window.addEventListener("offline", goOffline); window.addEventListener("online", goOnline);
    return () => { window.removeEventListener("offline", goOffline); window.removeEventListener("online", goOnline); };
  }, []);

  const refresh = async (): Promise<void> => { if (controller) setDrafts(await controller.list()); };
  const noteFailure = (error: unknown): string => {
    if (isConnectivityFailure(error)) { setLink("offline"); return "The Media host could not be reached. Working offline; drafts stay on this device."; }
    return error instanceof Error ? error.message : "Request failed.";
  };

  const probe = async (): Promise<void> => {
    setBusy(true);
    try {
      const read = await client.getProject(project.projectId);
      setBase(read.project.headRevisionId); setLink("online");
      setMessage(`Connected. Project head is ${read.project.headRevisionId}. Drafts are not sent automatically.`);
    } catch (error) { setMessage(noteFailure(error)); }
    finally { setBusy(false); }
  };

  const capture = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!controller) return;
    const id = targetId.trim();
    const parsedOrder = Number(order);
    if (!ID.test(effectiveTimelineId) || !ID.test(id) || (kind === "addScene" && !(Number.isInteger(parsedOrder) && parsedOrder >= 0))) {
      setMessage("Enter a timeline, a valid id and (for add scene) a non-negative integer order."); return;
    }
    const edit: DevTimelineEdit = kind === "addScene" ? { type: "addScene", sceneId: id, order: parsedOrder }
      : kind === "removeScene" ? { type: "removeScene", sceneId: id } : { type: "removeClip", clipId: id };
    setBusy(true);
    try {
      const draft = await controller.capture({ timelineId: effectiveTimelineId, edits: [edit], baseRevisionId: base });
      await refresh(); setTargetId("");
      setMessage(`Saved offline draft ${draft.requestId} against base revision ${draft.baseRevisionId}. Nothing was sent.`);
    } catch (error) { setMessage(noteFailure(error)); }
    finally { setBusy(false); }
  };

  const review = async (draft: TimelineDraft): Promise<void> => {
    if (!controller) return;
    setBusy(true);
    try {
      const result = await controller.review(draft.editId);
      setReviews((current) => ({ ...current, [draft.editId]: result })); setLink("online");
      setMessage(`Reviewing draft ${draft.requestId}: base ${draft.baseRevisionId}, current head ${result.headRevisionId}. Nothing was sent.`);
    } catch (error) { setMessage(noteFailure(error)); }
    finally { setBusy(false); }
  };

  const confirm = async (draft: TimelineDraft): Promise<void> => {
    const reviewed = reviews[draft.editId];
    if (!controller || !reviewed) return;
    setBusy(true);
    try {
      const outcome = await controller.replay(reviewed);
      setOutcomes((current) => ({ ...current, [draft.editId]: outcome }));
      setReviews((current) => { const { [draft.editId]: _gone, ...rest } = current; return rest; });
      if (outcome.kind === "APPLIED" || outcome.kind === "REPLAYED") setBase(outcome.revisionId);
      if (outcome.kind === "REVISION_CONFLICT") setBase(outcome.currentHeadRevisionId);
      setMessage(describeOutcome(outcome));
      await refresh();
    } catch (error) { setMessage(noteFailure(error)); }
    finally { setBusy(false); }
  };

  const act = async (work: () => Promise<void>, done: string): Promise<void> => {
    setBusy(true);
    try { await work(); await refresh(); setMessage(done); } catch (error) { setMessage(noteFailure(error)); }
    finally { setBusy(false); }
  };

  const offline = link === "offline";
  const effectiveTimelineId = revision.timelines.some((item) => item.graph.timelineId === timelineId)
    ? timelineId : revision.timelines[0]?.graph.timelineId ?? "";
  return <section className="media-screen-body" aria-labelledby="dev-offline-drafts-title" data-offline={offline ? "true" : "false"}>
    <h3 id="dev-offline-drafts-title">Offline drafts</h3>
    <p>
      Key custody is browser-held: an unexportable AES-GCM key per tenant, principal and project stays in this browser and is never derived from your token.
      Drafts are inert and bound to the base revision they were written against. Clearing site data loses drafts by design.
    </p>
    <p data-testid="offline-link-state">Connection: <strong>{offline ? "Offline" : "Online"}</strong>. Base head for new drafts: <code>{base}</code>.
      {" "}<button type="button" onClick={() => void probe()} disabled={busy}>Check connection</button></p>
    {fatal && <p role="alert">Offline drafts are unavailable: {fatal}</p>}
    <p role="status" data-testid="offline-draft-status">{message}</p>
    <form id="offline-draft-form" onSubmit={(event) => void capture(event)}>
      <label>Timeline <select value={effectiveTimelineId} onChange={(event) => setTimelineId(event.target.value)}>
        {revision.timelines.map((item) => <option key={item.graph.timelineId} value={item.graph.timelineId}>{item.graph.timelineId}</option>)}
      </select></label>
      <label>Edit <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
        <option value="addScene">Add scene</option><option value="removeScene">Remove scene</option><option value="removeClip">Remove clip</option>
      </select></label>
      <label>{kind === "removeClip" ? "Clip id" : "Scene id"} <input value={targetId} onChange={(event) => setTargetId(event.target.value)} /></label>
      {kind === "addScene" && <label>Order <input inputMode="numeric" value={order} onChange={(event) => setOrder(event.target.value)} /></label>}
      <button type="submit" disabled={busy || !controller}>Save as offline draft</button>
    </form>
    {drafts.length === 0 ? <p>No offline drafts.</p> : <ul aria-label="Offline drafts">
      {drafts.map((draft) => {
        const reviewed = reviews[draft.editId];
        const outcome = outcomes[draft.editId];
        return <li key={draft.editId} data-draft-state={draft.state}>
          <p><strong>{draft.state}</strong> on {draft.timelineId}, base <code>{draft.baseRevisionId}</code>, request <code>{draft.requestId}</code></p>
          <ul>{draft.edits.map((edit, index) => <li key={index}>{describeEdit(edit)}</li>)}</ul>
          {outcome && <p role="status">{describeOutcome(outcome)}</p>}
          {!reviewed && <button type="button" onClick={() => void review(draft)} disabled={busy || offline}>Review and replay</button>}
          {reviewed && <div aria-label="Draft review">
            <p>Authored on <code>{reviewed.draft.baseRevisionId}</code>; project head now <code>{reviewed.headRevisionId}</code>
              {reviewed.stale ? " (changed: replay will report REVISION_CONFLICT and will not merge)." : " (unchanged)."}</p>
            {reviewed.draft.state === "PENDING" && <button type="button" onClick={() => void confirm(draft)} disabled={busy}>Confirm replay</button>}
            {reviewed.draft.state === "OUTCOME_UNKNOWN" && <p>{reviewed.reconciliation === "NOT_APPLIED_CONFIRMED"
              ? "The head still equals the base, so the earlier request did not commit."
              : "The head moved; the earlier request may have committed. It cannot be re-sent safely."}</p>}
            {reviewed.reconciliation === "NOT_APPLIED_CONFIRMED" && <button type="button" disabled={busy}
              onClick={() => void act(() => controller!.rearmUnknown(reviewed), "Draft re-armed with the same requestId. Review again to replay.").then(() => setReviews((c) => { const { [draft.editId]: _g, ...r } = c; return r; }))}>Retry same requestId</button>}
            {reviewed.draft.state === "CONFLICT" && <button type="button" disabled={busy}
              onClick={() => void act(async () => { await controller!.rebaseConflict(draft.editId, reviewed.headRevisionId); }, "Draft rebased onto the current head with a new requestId. It was not sent.")
                .then(() => setReviews((c) => { const { [draft.editId]: _g, ...r } = c; return r; }))}>Rebase onto current head</button>}
            <button type="button" onClick={() => setReviews((c) => { const { [draft.editId]: _g, ...r } = c; return r; })} disabled={busy}>Close review</button>
          </div>}
          <button type="button" disabled={busy} onClick={() => void act(async () => { await controller!.discard(draft.editId); }, "Draft discarded from this browser.")}>Discard draft</button>
        </li>;
      })}
    </ul>}
  </section>;
}
