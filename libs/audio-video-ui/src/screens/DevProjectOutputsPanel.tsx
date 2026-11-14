import React from "react";
import type { DevProject, DevProjectRevision } from "@audio-video/client/dev-project-timeline";
import {
  DevOutputsHostError, describeRenderFailure, describeReviewFailure, parseRenderView, parseReviewReceipt, parseReviewView,
  type DevCommentDisposition, type DevProjectOutputsPort, type DevRenderFormat, type DevReviewDecision,
  type DevReviewSubject, type Outcome, type RenderView, type ReviewView,
} from "./devProjectOutputs";

export interface DevProjectOutputsPanelProps {
  readonly outputs: DevProjectOutputsPort;
  readonly project: DevProject;
  /** Revision currently displayed by the workspace (renders and reviews bind this exact id). */
  readonly revision: DevProjectRevision;
  readonly timelineId: string | null;
  readonly clipCount: number;
  readonly locked: boolean;
  /** Injectable for deterministic tests; must return a fresh opaque id per call. */
  readonly newRequestId?: () => string;
}

type Attempt = { readonly fingerprint: string; readonly requestId: string };
type Shown = { readonly view: RenderView; readonly via: "created" | "replayed" | "reopened" };
type Pending = "render" | "reopen" | "open-review" | "refresh-review" | "comment" | "decision" | null;

let counter = 0;
const defaultRequestId = (): string => {
  const random = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${(counter++).toString(36)}`;
  return `ui-${random}`;
};
const asHost = (error: unknown): DevOutputsHostError => error instanceof DevOutputsHostError ? error
  : new DevOutputsHostError("INVALID_RESPONSE", 200, error instanceof Error ? error.message : "Invalid response.");
const POSITIVE = /^[1-9][0-9]{0,4}$/u;
const DISPOSITIONS: readonly DevCommentDisposition[] = ["OPEN", "RESOLVED", "NEEDS_OWNER_RESPONSE"];
const DECISIONS: readonly DevReviewDecision[] = ["ACCEPT", "REJECT", "REQUEST_CHANGES", "DEFER"];

/** DEV_ONLY render and review controls. It never claims approval, export or delivery. */
export function DevProjectOutputsPanel({ outputs, project, revision, timelineId, clipCount, locked, newRequestId = defaultRequestId }: DevProjectOutputsPanelProps): React.ReactElement {
  const [format, setFormat] = React.useState<DevRenderFormat>("gif");
  const [width, setWidth] = React.useState("32");
  const [height, setHeight] = React.useState("24");
  const [fps, setFps] = React.useState("10");
  const [shown, setShown] = React.useState<Shown | null>(null);
  const [renderOutcome, setRenderOutcome] = React.useState<Outcome | null>(null);
  const [renderMessage, setRenderMessage] = React.useState("No render requested.");
  const [pending, setPending] = React.useState<Pending>(null);
  const renderAttempt = React.useRef<Attempt | null>(null);

  const [subjectChoice, setSubjectChoice] = React.useState<"revision" | "render">("revision");
  const [review, setReview] = React.useState<ReviewView | null>(null);
  const [reviewOutcome, setReviewOutcome] = React.useState<Outcome | null>(null);
  const [reviewMessage, setReviewMessage] = React.useState("No review case opened.");
  const [commentText, setCommentText] = React.useState("");
  const [disposition, setDisposition] = React.useState<DevCommentDisposition>("OPEN");
  const [decision, setDecision] = React.useState<DevReviewDecision>("ACCEPT");
  const [reason, setReason] = React.useState("");
  const [confirmed, setConfirmed] = React.useState(false);
  const commentAttempt = React.useRef<Attempt | null>(null);
  const decisionAttempt = React.useRef<Attempt | null>(null);

  const isHead = project.headRevisionId === revision.revisionId;
  const busy = pending !== null;
  const widthN = POSITIVE.test(width) ? Number(width) : 0;
  const heightN = POSITIVE.test(height) ? Number(height) : 0;
  const fpsN = POSITIVE.test(fps) ? Number(fps) : 0;
  const renderBlock = !timelineId ? "Select a timeline to render."
    : clipCount === 0 ? "Add at least one clip before rendering."
      : !isHead ? "Reopen the project head: only the current head revision can be rendered."
        : widthN === 0 || heightN === 0 || fpsN === 0 ? "Width, height and frames per second must be positive whole numbers." : null;
  const renderEnabled = !locked && !busy && renderBlock === null;

  const fingerprint = `${project.projectId}|${revision.revisionId}|${timelineId}|${format}|${widthN}x${heightN}@${fpsN}`;
  const attemptFor = (ref: React.MutableRefObject<Attempt | null>, fp: string): Attempt => {
    if (!ref.current || ref.current.fingerprint !== fp) ref.current = { fingerprint: fp, requestId: newRequestId() };
    return ref.current;
  };

  const requestRender = async (): Promise<void> => {
    if (!renderEnabled || !timelineId) return;
    const attempt = attemptFor(renderAttempt, fingerprint);
    const expected = { projectId: project.projectId, revisionId: revision.revisionId, format };
    setPending("render"); setRenderOutcome(null);
    setRenderMessage(`Requesting ${format.toUpperCase()} render of exact revision ${revision.revisionId}…`);
    try {
      const response = await outputs.requestRender(project.projectId, {
        requestId: attempt.requestId, revisionId: revision.revisionId, timelineId, width: widthN, height: heightN,
        framesPerSecond: fpsN, format,
      });
      if (response.status !== 200 && response.status !== 201) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected success status.");
      const view = parseRenderView(response.body, expected);
      if ((response.status === 200) !== view.replayed) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Status and replay flag disagree.");
      setShown({ view, via: view.replayed ? "replayed" : "created" });
      setRenderMessage(view.replayed
        ? `Replayed (HTTP 200): the same request identity returned existing artifact ${view.artifactId}; no second output was created.`
        : `Created (HTTP 201): registered ${view.contentType} artifact ${view.artifactId} for exact revision ${view.revisionId}.`);
    } catch (error) {
      const failure = asHost(error);
      const outcome = describeRenderFailure(failure);
      if (outcome.discardRequest) renderAttempt.current = null;
      setRenderOutcome(outcome);
      setRenderMessage(`${outcome.code}: ${outcome.text}`);
    } finally { setPending(null); }
  };

  const reopenRender = async (): Promise<void> => {
    if (!shown || busy) return;
    setPending("reopen"); setRenderOutcome(null);
    setRenderMessage(`Reopening render ${shown.view.renderId}…`);
    try {
      const response = await outputs.getRender(project.projectId, shown.view.renderId);
      if (response.status !== 200) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected status.");
      const view = parseRenderView(response.body, { projectId: project.projectId });
      if (view.renderId !== shown.view.renderId || view.sha256 !== shown.view.sha256) {
        throw new DevOutputsHostError("INVALID_RESPONSE", 200, "Reopened render does not match the registered artifact.");
      }
      setShown({ view, via: "reopened" });
      setRenderMessage(`Reopened render ${view.renderId}: artifact version ${view.artifactVersionId} matches the registered output.`);
    } catch (error) {
      const outcome = describeRenderFailure(asHost(error));
      setRenderOutcome({ ...outcome, retrySameRequest: false });
      setRenderMessage(`${outcome.code}: ${outcome.text}`);
    } finally { setPending(null); }
  };

  const subject = (): DevReviewSubject | null => subjectChoice === "render"
    ? shown ? { kind: "ARTIFACT_VERSION", artifactId: shown.view.artifactId, artifactVersionId: shown.view.artifactVersionId } : null
    : { kind: "PROJECT_REVISION", projectId: project.projectId, revisionId: revision.revisionId };

  const failReview = (error: unknown): Outcome => {
    const outcome = describeReviewFailure(error);
    setReviewOutcome(outcome);
    setReviewMessage(`${outcome.code}: ${outcome.text}`);
    return outcome;
  };
  const readCase = async (caseId: string): Promise<ReviewView> => {
    const response = await outputs.getReview(caseId);
    if (response.status !== 200) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected status.");
    const view = parseReviewView(response.body);
    if (view.reviewCaseId !== caseId) throw new DevOutputsHostError("INVALID_RESPONSE", 200, "Review case identity mismatch.");
    return view;
  };

  const openReview = async (): Promise<void> => {
    const target = subject();
    if (!target || busy || locked) return;
    setPending("open-review"); setReviewOutcome(null);
    setReviewMessage("Opening a DEV_ONLY review case on the exact version…");
    try {
      const response = await outputs.openReview(target);
      if (response.status !== 200 && response.status !== 201) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected status.");
      const view = parseReviewView(response.body);
      const wanted = target.kind === "PROJECT_REVISION"
        ? `project_revision:${target.projectId}@${target.revisionId}` : null;
      if (view.subjectKind !== target.kind || (wanted !== null && view.subjectReference !== wanted)) {
        throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Review subject does not match the requested exact version.");
      }
      commentAttempt.current = null; decisionAttempt.current = null; setConfirmed(false);
      setReview(view);
      setReviewMessage(`${response.status === 201 ? "Opened" : "Reopened existing"} DEV_ONLY review case ${view.reviewCaseId} (${view.currentness}). No approval exists.`);
    } catch (error) { failReview(asHost(error)); } finally { setPending(null); }
  };

  const refreshReview = async (): Promise<void> => {
    if (!review || busy) return;
    setPending("refresh-review");
    try {
      const view = await readCase(review.reviewCaseId);
      setReview(view);
      setReviewOutcome(null);
      setReviewMessage(`Re-read review case ${view.reviewCaseId}: ${view.currentness}, case revision ${view.caseRevision}.`);
    } catch (error) { failReview(asHost(error)); } finally { setPending(null); }
  };

  // Currentness is host-derived; re-read when the displayed project head moves so STALE is surfaced.
  const reviewCaseId = review?.reviewCaseId ?? null;
  React.useEffect(() => {
    if (!reviewCaseId) return;
    let cancelled = false;
    readCase(reviewCaseId).then((view) => {
      if (cancelled) return;
      setReview(view);
      setReviewMessage(`Re-read review case ${view.reviewCaseId} after a project head change: ${view.currentness}.`);
    }).catch((error) => { if (!cancelled) failReview(asHost(error)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.headRevisionId, reviewCaseId]);

  const submitComment = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!review || busy || commentText.trim() === "") return;
    const attempt = attemptFor(commentAttempt, `${review.reviewCaseId}|${review.caseRevision}|${disposition}|${commentText}`);
    setPending("comment"); setReviewOutcome(null);
    setReviewMessage("Recording comment…");
    try {
      const response = await outputs.addReviewComment(review.reviewCaseId, {
        requestId: attempt.requestId, expectedCaseRevision: review.caseRevision, text: commentText, disposition,
      });
      if (response.status !== 200 && response.status !== 201) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected status.");
      const receipt = parseReviewReceipt(response.body, review.reviewCaseId);
      const view = await readCase(review.reviewCaseId);
      setReview(view); commentAttempt.current = null; setCommentText("");
      setReviewMessage(`${receipt.replayed ? "Replayed (HTTP 200): comment already recorded" : "Recorded comment (HTTP 201)"} at case revision ${receipt.caseRevision}; subject is ${receipt.currentness}.`);
    } catch (error) {
      const outcome = failReview(asHost(error));
      if (outcome.discardRequest) { commentAttempt.current = null; void readCase(review.reviewCaseId).then(setReview).catch(() => undefined); }
    } finally { setPending(null); }
  };

  const submitDecision = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!review || busy || !confirmed || reason.trim() === "" || review.currentness !== "CURRENT") return;
    const attempt = attemptFor(decisionAttempt, `${review.reviewCaseId}|${review.caseRevision}|${decision}|${reason}`);
    setPending("decision"); setReviewOutcome(null);
    setReviewMessage(`Recording DEV_ONLY ${decision} decision…`);
    try {
      const response = await outputs.recordReviewDecision(review.reviewCaseId, {
        requestId: attempt.requestId, expectedCaseRevision: review.caseRevision, decision, reason, confirmed: true,
      });
      if (response.status !== 200 && response.status !== 201) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected status.");
      const receipt = parseReviewReceipt(response.body, review.reviewCaseId);
      const view = await readCase(review.reviewCaseId);
      setReview(view); decisionAttempt.current = null; setConfirmed(false); setReason("");
      setReviewMessage(`${receipt.replayed ? "Replayed (HTTP 200): decision already recorded" : "Recorded DEV_ONLY decision (HTTP 201)"} at case revision ${receipt.caseRevision}; subject is ${receipt.currentness}. This is not human approval (establishesApproval=false).`);
    } catch (error) {
      const outcome = failReview(asHost(error));
      if (outcome.discardRequest || outcome.code === "REVIEW_SUBJECT_STALE") {
        decisionAttempt.current = null;
        void readCase(review.reviewCaseId).then(setReview).catch(() => undefined);
      }
    } finally { setPending(null); }
  };

  const retryRender = renderOutcome?.retrySameRequest && renderAttempt.current !== null;
  const stale = review?.currentness === "STALE";
  const renderIsOldHead = shown !== null && shown.view.revisionId !== project.headRevisionId;

  return <section id="dev-project-outputs" aria-labelledby="dev-outputs-title" data-outputs="DEV_ONLY">
    <h3 id="dev-outputs-title">Render and review · DEV_ONLY</h3>
    <p>Local development rendering of the exact project revision and a DEV_ONLY review case. Neither establishes human approval, export or delivery.</p>

    <section aria-labelledby="render-title">
      <h4 id="render-title">Render the current revision</h4>
      <form id="render-form" onSubmit={(event) => { event.preventDefault(); void requestRender(); }}>
        <fieldset aria-labelledby="render-format-legend">
          <legend id="render-format-legend">Output format</legend>
          {(["gif", "mp4"] as const).map((value) => <label key={value}>
            <input type="radio" name="render-format" value={value} checked={format === value} onChange={() => setFormat(value)} disabled={locked || busy} />
            {value === "gif" ? "GIF storyboard" : "MP4 (H.264/AAC, needs host FFmpeg)"}
          </label>)}
        </fieldset>
        <label htmlFor="render-width">Width in pixels</label>
        <input id="render-width" type="text" inputMode="numeric" value={width} onChange={(event) => setWidth(event.currentTarget.value)} disabled={locked || busy} aria-describedby="render-geometry-help" />
        <label htmlFor="render-height">Height in pixels</label>
        <input id="render-height" type="text" inputMode="numeric" value={height} onChange={(event) => setHeight(event.currentTarget.value)} disabled={locked || busy} aria-describedby="render-geometry-help" />
        <label htmlFor="render-fps">Frames per second</label>
        <input id="render-fps" type="text" inputMode="numeric" value={fps} onChange={(event) => setFps(event.currentTarget.value)} disabled={locked || busy} aria-describedby="render-geometry-help" />
        <p id="render-geometry-help">Frames per second must divide 100. MP4 needs even width and height. The host enforces size and source limits and answers with a typed refusal.</p>
        <p>Target: revision <code>{revision.revisionId}</code>{timelineId ? <>, timeline <code>{timelineId}</code></> : null}, {clipCount} clip{clipCount === 1 ? "" : "s"}.</p>
        {renderBlock && <p id="render-blocked">{renderBlock}</p>}
        <button type="submit" disabled={!renderEnabled}>Render exact revision</button>
        {retryRender && <button type="button" onClick={() => void requestRender()} disabled={!renderEnabled}>Retry with the same request identity</button>}
      </form>
      <p id="render-status" role="status" aria-live="polite" aria-atomic="true" aria-busy={pending === "render" || pending === "reopen"}
        data-state={renderOutcome ? renderOutcome.tone : shown ? shown.via : "idle"}>{renderMessage}</p>
      {renderOutcome && <p role="alert" data-outcome={renderOutcome.tone}><strong>{renderOutcome.tone === "unknown" ? "Outcome unknown" : renderOutcome.tone === "denied" ? "Denied" : renderOutcome.tone === "unavailable" ? "Unavailable" : "Not rendered"} · <code>{renderOutcome.code}</code></strong></p>}
      {shown && <article aria-labelledby="render-result-title" data-render-id={shown.view.renderId}>
        <h5 id="render-result-title">Registered render · {shown.via === "created" ? "created" : shown.via === "replayed" ? "replayed" : "reopened"}</h5>
        <dl>
          <div><dt>Render ID</dt><dd><code>{shown.view.renderId}</code></dd></div>
          <div><dt>Artifact ID</dt><dd><code>{shown.view.artifactId}</code></dd></div>
          <div><dt>Artifact version</dt><dd><code>{shown.view.artifactVersionId}</code></dd></div>
          <div><dt>SHA-256</dt><dd><code>{shown.view.sha256}</code></dd></div>
          <div><dt>Content type and size</dt><dd>{shown.view.contentType}{shown.view.sizeBytes === null ? "" : ` · ${shown.view.sizeBytes} bytes`}</dd></div>
          <div><dt>Rendered revision</dt><dd><code>{shown.view.revisionId}</code> · timeline <code>{shown.view.timelineId}</code>{shown.view.timelineSemanticVersionId ? <> · semantic version <code>{shown.view.timelineSemanticVersionId}</code></> : null}</dd></div>
          <div><dt>Engine</dt><dd>{shown.view.engine}{shown.view.frameCount === null ? "" : ` · ${shown.view.frameCount} frames`}</dd></div>
        </dl>
        {renderIsOldHead && <p role="note"><strong>Not the current head:</strong> this output was rendered from revision <code>{shown.view.revisionId}</code>; the project head is <code>{project.headRevisionId}</code>.</p>}
        <h6>Exact sources</h6>
        <ul aria-label="Render source lineage">{shown.view.sources.map((source) => <li key={`${source.trackId}:${source.clipId}`}>
          clip <code>{source.clipId}</code> · track <code>{source.trackId}</code>{source.trackKind ? ` (${source.trackKind})` : ""} · <code>{source.artifactId}@{source.artifactVersionId}</code>
          {source.startFrame !== null && source.endFrameExclusive !== null ? ` · frames ${source.startFrame}–${source.endFrameExclusive}` : ""}
        </li>)}</ul>
        {shown.view.encoding && <>
          <h6>Verified encoding</h6>
          <dl aria-label="Render encoding">
            <div><dt>Video codec</dt><dd>{shown.view.encoding.videoCodec}</dd></div>
            <div><dt>Audio codec</dt><dd>{shown.view.encoding.audioCodec}</dd></div>
            <div><dt>Exact video timestamps</dt><dd>{shown.view.encoding.videoPtsExact ? "Yes" : "No"}</dd></div>
            {shown.view.encoding.videoFrameCount !== null && <div><dt>Video frames</dt><dd>{shown.view.encoding.videoFrameCount}</dd></div>}
            {shown.view.encoding.expectedDurationSeconds !== null && <div><dt>Expected duration</dt><dd>{shown.view.encoding.expectedDurationSeconds} s</dd></div>}
          </dl>
        </>}
        <button type="button" onClick={() => void reopenRender()} disabled={busy}>Reopen render from the host</button>
      </article>}
    </section>

    <section aria-labelledby="review-title">
      <h4 id="review-title">DEV_ONLY review</h4>
      <aside role="note" aria-label="Review approval disclaimer" data-approval="false">
        <strong>A DEV_ONLY ACCEPT is not human approval.</strong> The reviewer is a synthetic local owner. Every review record carries establishesApproval=false and humanReviewApproval=false and authorizes no delivery or publication.
      </aside>
      <form id="review-open-form" onSubmit={(event) => { event.preventDefault(); void openReview(); }}>
        <fieldset aria-labelledby="review-subject-legend">
          <legend id="review-subject-legend">Exact version to review</legend>
          <label><input type="radio" name="review-subject" value="revision" checked={subjectChoice === "revision"} onChange={() => setSubjectChoice("revision")} disabled={locked || busy} />
            Project revision <code>{revision.revisionId}</code></label>
          <label><input type="radio" name="review-subject" value="render" checked={subjectChoice === "render"} onChange={() => setSubjectChoice("render")} disabled={locked || busy || !shown} />
            {shown ? <>Render artifact version <code>{shown.view.artifactVersionId}</code></> : "Render artifact version (render first)"}</label>
        </fieldset>
        <button type="submit" disabled={locked || busy || subject() === null}>Open review case</button>
      </form>
      <p id="review-status" role="status" aria-live="polite" aria-atomic="true" aria-busy={pending === "open-review" || pending === "refresh-review" || pending === "comment" || pending === "decision"}
        data-state={reviewOutcome ? reviewOutcome.tone : review ? review.currentness : "idle"}>{reviewMessage}</p>
      {reviewOutcome && <p role="alert" data-outcome={reviewOutcome.tone}><strong>{reviewOutcome.tone === "unknown" ? "Outcome unknown" : reviewOutcome.tone === "denied" ? "Denied" : reviewOutcome.tone === "unavailable" ? "Unavailable" : "Not recorded"} · <code>{reviewOutcome.code}</code></strong></p>}
      {review && <article aria-labelledby="review-case-title" data-review-case={review.reviewCaseId}>
        <h5 id="review-case-title">Review case <code>{review.reviewCaseId}</code></h5>
        <dl>
          <div><dt>Exact subject</dt><dd><code>{review.subjectReference}</code></dd></div>
          <div><dt>Currentness</dt><dd data-currentness={review.currentness}>{review.currentness === "CURRENT" ? "CURRENT · subject is still the exact reviewed version"
            : review.currentness === "STALE" ? "STALE · the reviewed version has changed; earlier decisions no longer apply and new decisions are refused"
              : "UNKNOWN · currentness could not be established; do not rely on earlier decisions"}</dd></div>
          <div><dt>Case revision</dt><dd>{review.caseRevision}</dd></div>
          <div><dt>Decision state</dt><dd><code>{review.status}</code></dd></div>
          <div><dt>Establishes approval</dt><dd>No · establishesApproval=false · humanReviewApproval=false</dd></div>
          <div><dt>Authority</dt><dd>{review.authority}</dd></div>
        </dl>
        {review.note && <p>{review.note}</p>}
        {review.records.length === 0 ? <p>No comments or decisions yet.</p> : <ol aria-label="Review records">{review.records.map((record) => <li key={record.appendRecordId}>
          #{record.caseRevision} · {record.kind === "COMMENT" ? `comment (${record.disposition ?? "OPEN"})` : `DEV_ONLY decision ${record.decision ?? ""}`} · {record.currentness}
          {record.kind === "COMMENT" ? ` · ${record.text ?? ""}` : record.reason ? ` · ${record.reason}` : ""}
        </li>)}</ol>}
        <button type="button" onClick={() => void refreshReview()} disabled={busy}>Re-read review case</button>
        <form id="review-comment-form" onSubmit={(event) => void submitComment(event)}>
          <label htmlFor="review-comment-text">Comment</label>
          <textarea id="review-comment-text" value={commentText} onChange={(event) => setCommentText(event.currentTarget.value)} disabled={busy} required />
          <label htmlFor="review-comment-disposition">Disposition</label>
          <select id="review-comment-disposition" value={disposition} onChange={(event) => setDisposition(event.currentTarget.value as DevCommentDisposition)} disabled={busy}>
            {DISPOSITIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <button type="submit" disabled={busy || commentText.trim() === ""}>Add comment</button>
        </form>
        <form id="review-decision-form" onSubmit={(event) => void submitDecision(event)}>
          <label htmlFor="review-decision">Decision</label>
          <select id="review-decision" value={decision} onChange={(event) => { setDecision(event.currentTarget.value as DevReviewDecision); setConfirmed(false); }} disabled={busy || stale}>
            {DECISIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <label htmlFor="review-reason">Reason</label>
          <input id="review-reason" value={reason} onChange={(event) => setReason(event.currentTarget.value)} disabled={busy || stale} required />
          <label htmlFor="review-confirm"><input id="review-confirm" type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)} disabled={busy || stale} />
            I confirm this records a DEV_ONLY {decision} decision on this exact version only. It is not human approval.</label>
          {stale && <p role="note">Decisions are disabled because this case is STALE. Open a review case on the new exact version.</p>}
          <button type="submit" disabled={busy || stale || !confirmed || reason.trim() === "" || review.currentness !== "CURRENT"}>Record DEV_ONLY decision</button>
        </form>
      </article>}
    </section>
  </section>;
}
