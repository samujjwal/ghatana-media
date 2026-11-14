import React from "react";
import {
  DEV_REVIEW_SCOPES, DevOutputsHostError, decisionGate, describeReviewFailure, parseAssignmentChange, parseReviewReceipt, parseReviewView,
  type DevCommentDisposition, type DevProjectOutputsPort, type DevReviewDecision, type DevReviewScope, type DevReviewSubject,
  type Outcome, type ReviewAssignmentView, type ReviewView,
} from "./devProjectOutputs";

/** One exact version the open-case form may bind. */
export interface DevReviewSubjectChoice {
  readonly id: "revision" | "render";
  readonly label: React.ReactNode;
  readonly subject: DevReviewSubject | null;
  /** Exact subject reference the host must echo for this choice, when it can be predicted. */
  readonly wantedReference: string | null;
  readonly disabled?: boolean;
}

export interface DevReviewSectionProps {
  readonly outputs: DevProjectOutputsPort;
  readonly locked: boolean;
  readonly newRequestId: () => string;
  /** Project a reopened PROJECT_REVISION case must belong to; null for a reviewer who cannot read the project. */
  readonly projectId: string | null;
  /** Changing value (for example the project head) that triggers a currentness re-read of the open case. */
  readonly headKey: string | null;
  /** Exact versions the owner may open a case on. Empty for the standalone assigned-reviewer view. */
  readonly subjectChoices: readonly DevReviewSubjectChoice[];
  readonly onBusyChange?: (busy: boolean) => void;
}

type Attempt = { readonly fingerprint: string; readonly requestId: string; readonly expiresAt?: string };
type Pending = "open-review" | "refresh-review" | "comment" | "decision" | "assign" | "revoke" | null;

const DECISIONS: readonly DevReviewDecision[] = ["ACCEPT", "REJECT", "REQUEST_CHANGES", "DEFER"];
const DISPOSITIONS: readonly DevCommentDisposition[] = ["OPEN", "RESOLVED", "NEEDS_OWNER_RESPONSE"];
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_DAYS = 30;
const DAY_MS = 86_400_000;

const asHost = (error: unknown): DevOutputsHostError => error instanceof DevOutputsHostError ? error
  : new DevOutputsHostError("INVALID_RESPONSE", 200, error instanceof Error ? error.message : "Invalid response.");

/** DEV_ONLY review: open or reopen a case, owner-assigned reviewers, comments and scoped decisions. Nothing here is approval. */
export function DevReviewSection({ outputs, locked, newRequestId, projectId, headKey, subjectChoices, onBusyChange }: DevReviewSectionProps): React.ReactElement {
  const principalId = outputs.principalId;
  const [knownReviewId, setKnownReviewId] = React.useState("");
  const [subjectChoice, setSubjectChoice] = React.useState<"revision" | "render">("revision");
  const [review, setReview] = React.useState<ReviewView | null>(null);
  const [reviewOutcome, setReviewOutcome] = React.useState<Outcome | null>(null);
  const [reviewMessage, setReviewMessage] = React.useState("No review case opened.");
  const [pending, setPending] = React.useState<Pending>(null);
  const [commentText, setCommentText] = React.useState("");
  const [disposition, setDisposition] = React.useState<DevCommentDisposition>("OPEN");
  const [decision, setDecision] = React.useState<DevReviewDecision>("ACCEPT");
  const [scope, setScope] = React.useState<DevReviewScope | "">("");
  const [reason, setReason] = React.useState("");
  const [confirmed, setConfirmed] = React.useState(false);
  const [reviewerId, setReviewerId] = React.useState("");
  const [assignScopes, setAssignScopes] = React.useState<readonly DevReviewScope[]>([]);
  const [expiryDays, setExpiryDays] = React.useState("7");
  const commentAttempt = React.useRef<Attempt | null>(null);
  const decisionAttempt = React.useRef<Attempt | null>(null);
  const assignAttempt = React.useRef<Attempt | null>(null);
  const revokeAttempt = React.useRef<Attempt | null>(null);

  const busy = pending !== null;
  React.useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  const attemptFor = (ref: React.MutableRefObject<Attempt | null>, fp: string, extra?: () => Partial<Attempt>): Attempt => {
    if (!ref.current || ref.current.fingerprint !== fp) ref.current = { fingerprint: fp, requestId: newRequestId(), ...(extra?.() ?? {}) };
    return ref.current;
  };

  const choice = subjectChoices.find((candidate) => candidate.id === subjectChoice) ?? subjectChoices[0] ?? null;
  const target = choice?.subject ?? null;

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
  const resetAttempts = (): void => {
    commentAttempt.current = null; decisionAttempt.current = null; assignAttempt.current = null; revokeAttempt.current = null;
    setConfirmed(false);
  };

  const openReview = async (): Promise<void> => {
    if (!target || busy || locked) return;
    setPending("open-review"); setReviewOutcome(null);
    setReviewMessage("Opening a DEV_ONLY review case on the exact version…");
    try {
      const response = await outputs.openReview(target);
      if (response.status !== 200 && response.status !== 201) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected status.");
      const view = parseReviewView(response.body);
      const wanted = choice?.wantedReference ?? null;
      if (view.subjectKind !== target.kind || (wanted !== null && view.subjectReference !== wanted)) {
        throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Review subject does not match the requested exact version.");
      }
      resetAttempts();
      setReview(view);
      setReviewMessage(`${response.status === 201 ? "Opened" : "Reopened existing"} DEV_ONLY review case ${view.reviewCaseId} (${view.currentness}). No approval exists.`);
    } catch (error) { failReview(asHost(error)); } finally { setPending(null); }
  };

  const reopenKnownReview = async (): Promise<void> => {
    const caseId = knownReviewId.trim();
    if (busy || !OPAQUE_ID.test(caseId)) return;
    setPending("refresh-review"); setReviewOutcome(null);
    setReviewMessage(`Reopening known review case ${caseId}…`);
    try {
      const view = await readCase(caseId);
      if (projectId !== null && view.subjectKind === "PROJECT_REVISION" && !view.subjectReference.startsWith(`project_revision:${projectId}@`)) {
        throw new DevOutputsHostError("INVALID_RESPONSE", 200, "Review case belongs to a different project.");
      }
      resetAttempts();
      setReview(view); setKnownReviewId("");
      setReviewMessage(`Reopened review case ${view.reviewCaseId}: ${view.currentness}, case revision ${view.caseRevision}. No approval exists.`);
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
  const watchedCase = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!reviewCaseId) { watchedCase.current = null; return; }
    // The open/reopen action just read this case; only a later head change needs a re-read.
    if (watchedCase.current !== reviewCaseId) { watchedCase.current = reviewCaseId; return; }
    let cancelled = false;
    readCase(reviewCaseId).then((view) => {
      if (cancelled) return;
      setReview(view);
      setReviewMessage(`Re-read review case ${view.reviewCaseId} after a project head change: ${view.currentness}.`);
    }).catch((error) => { if (!cancelled) failReview(asHost(error)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headKey, reviewCaseId]);

  const reread = (caseId: string): void => { void readCase(caseId).then(setReview).catch(() => undefined); };

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
      if (outcome.discardRequest) { commentAttempt.current = null; reread(review.reviewCaseId); }
    } finally { setPending(null); }
  };

  const gate = review ? decisionGate(review, principalId) : null;
  const allowedScopes = gate?.allowed ? gate.scopes : [];
  const effectiveScope: DevReviewScope | "" = scope !== "" && allowedScopes.includes(scope) ? scope : "";
  const stale = review?.currentness === "STALE";
  const decisionsOff = !gate?.allowed || stale;

  const submitDecision = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!review || busy || !confirmed || reason.trim() === "" || review.currentness !== "CURRENT" || !gate?.allowed || effectiveScope === "") return;
    const attempt = attemptFor(decisionAttempt, `${review.reviewCaseId}|${review.caseRevision}|${decision}|${effectiveScope}|${reason}`);
    setPending("decision"); setReviewOutcome(null);
    setReviewMessage(`Recording DEV_ONLY ${decision} decision (${effectiveScope})…`);
    try {
      const response = await outputs.recordReviewDecision(review.reviewCaseId, {
        requestId: attempt.requestId, expectedCaseRevision: review.caseRevision, decision, scope: effectiveScope, reason, confirmed: true,
      });
      if (response.status !== 200 && response.status !== 201) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected status.");
      const receipt = parseReviewReceipt(response.body, review.reviewCaseId);
      const view = await readCase(review.reviewCaseId);
      setReview(view); decisionAttempt.current = null; setConfirmed(false); setReason("");
      setReviewMessage(`${receipt.replayed ? "Replayed (HTTP 200): decision already recorded" : "Recorded DEV_ONLY decision (HTTP 201)"} at case revision ${receipt.caseRevision}; subject is ${receipt.currentness}. This is not human approval (establishesApproval=false).`);
    } catch (error) {
      const outcome = failReview(asHost(error));
      if (outcome.discardRequest || outcome.code === "REVIEW_SUBJECT_STALE" || outcome.tone === "denied") {
        decisionAttempt.current = null;
        reread(review.reviewCaseId);
      }
    } finally { setPending(null); }
  };

  const daysN = /^[0-9]{1,2}$/u.test(expiryDays) ? Number(expiryDays) : 0;
  const daysOk = daysN >= 1 && daysN <= MAX_DAYS;
  const reviewerOk = OPAQUE_ID.test(reviewerId.trim());
  const myAssignments = review && principalId ? review.assignments.filter((a) => a.reviewerPrincipalId === principalId) : [];
  const ownedByOther = review && principalId ? review.assignments.some((a) => a.assignedByPrincipalId !== principalId) : false;
  const canManage = review !== null && myAssignments.length === 0 && !ownedByOther;
  const assignDisabled = busy || locked || !reviewerOk || assignScopes.length === 0 || !daysOk;
  const sortedScopes = [...assignScopes].sort();

  const submitAssign = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!review || assignDisabled) return;
    const attempt = attemptFor(assignAttempt, `${review.reviewCaseId}|${review.caseRevision}|${reviewerId.trim()}|${sortedScopes.join(",")}|${daysN}`,
      () => ({ expiresAt: new Date(Date.now() + daysN * DAY_MS - 60_000).toISOString() }));
    setPending("assign"); setReviewOutcome(null);
    setReviewMessage(`Assigning ${reviewerId.trim()} as DEV_ONLY reviewer for ${sortedScopes.join(", ")}…`);
    try {
      const response = await outputs.assignReviewer(review.reviewCaseId, {
        requestId: attempt.requestId, expectedCaseRevision: review.caseRevision, reviewerPrincipalId: reviewerId.trim(),
        scopes: sortedScopes, expiresAt: attempt.expiresAt ?? new Date(Date.now() + daysN * DAY_MS - 60_000).toISOString(),
      });
      if (response.status !== 200 && response.status !== 201) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected status.");
      const change = parseAssignmentChange(response.body, review.reviewCaseId);
      const view = await readCase(review.reviewCaseId);
      setReview(view); assignAttempt.current = null; setReviewerId(""); setAssignScopes([]);
      setReviewMessage(`${change.replayed ? "Replayed (HTTP 200): assignment already recorded" : "Assigned (HTTP 201)"} ${change.assignment.reviewerPrincipalId} for ${change.assignment.scopes.join(", ")} until ${change.assignment.expiresAt}. DEV_ONLY authority only; not human approval.`);
    } catch (error) {
      const outcome = failReview(asHost(error));
      if (outcome.discardRequest) { assignAttempt.current = null; reread(review.reviewCaseId); }
    } finally { setPending(null); }
  };

  const revoke = async (assignment: ReviewAssignmentView): Promise<void> => {
    if (!review || busy || locked) return;
    const attempt = attemptFor(revokeAttempt, `${review.reviewCaseId}|${review.caseRevision}|${assignment.assignmentId}`);
    setPending("revoke"); setReviewOutcome(null);
    setReviewMessage(`Revoking ${assignment.reviewerPrincipalId}'s reviewer assignment…`);
    try {
      const response = await outputs.revokeReviewAssignment(review.reviewCaseId, assignment.assignmentId, {
        requestId: attempt.requestId, expectedCaseRevision: review.caseRevision,
      });
      if (response.status !== 200 && response.status !== 201) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected status.");
      const change = parseAssignmentChange(response.body, review.reviewCaseId);
      const view = await readCase(review.reviewCaseId);
      setReview(view); revokeAttempt.current = null;
      setReviewMessage(`${change.replayed ? "Replayed: revocation already recorded" : "Revoked"} ${change.assignment.reviewerPrincipalId}'s assignment (${change.assignment.status}).`);
    } catch (error) {
      const outcome = failReview(asHost(error));
      if (outcome.discardRequest) { revokeAttempt.current = null; reread(review.reviewCaseId); }
    } finally { setPending(null); }
  };

  const toggleScope = (value: DevReviewScope, on: boolean): void =>
    setAssignScopes((current) => on ? [...new Set([...current, value])] : current.filter((entry) => entry !== value));

  return <section aria-labelledby="review-title">
    <h4 id="review-title">DEV_ONLY review</h4>
    <aside role="note" aria-label="Review approval disclaimer" data-approval="false">
      <strong>A DEV_ONLY ACCEPT is not human approval.</strong> A DEV_ONLY decision is recorded either by the synthetic local owner or by a reviewer the owner assigned for this case. The DEV_ONLY signed identity is not a trusted human identity, so every review record carries establishesApproval=false and humanReviewApproval=false and authorizes no delivery or publication. DEV_ASSIGNED_REVIEWER_ACCEPT is DEV-only evidence.
    </aside>
    {subjectChoices.length > 0 && <form id="review-open-form" onSubmit={(event) => { event.preventDefault(); void openReview(); }}>
      <fieldset aria-labelledby="review-subject-legend">
        <legend id="review-subject-legend">Exact version to review</legend>
        {subjectChoices.map((entry) => <label key={entry.id}><input type="radio" name="review-subject" value={entry.id} checked={choice?.id === entry.id}
          onChange={() => setSubjectChoice(entry.id)} disabled={locked || busy || entry.disabled === true} />{entry.label}</label>)}
      </fieldset>
      <button type="submit" disabled={locked || busy || target === null}>Open review case</button>
    </form>}
    <p id="review-status" role="status" aria-live="polite" aria-atomic="true" aria-busy={busy}
      data-state={reviewOutcome ? reviewOutcome.tone : review ? review.currentness : "idle"}>{reviewMessage}</p>
    {reviewOutcome && <p role="alert" data-outcome={reviewOutcome.tone}><strong>{reviewOutcome.tone === "unknown" ? "Outcome unknown" : reviewOutcome.tone === "denied" ? "Denied" : reviewOutcome.tone === "unavailable" ? "Unavailable" : "Not recorded"} · <code>{reviewOutcome.code}</code></strong></p>}
    <form id="review-known-form" onSubmit={(event) => { event.preventDefault(); void reopenKnownReview(); }}>
      <label htmlFor="known-review-id">Known review case ID</label>
      <input id="known-review-id" value={knownReviewId} onChange={(event) => setKnownReviewId(event.currentTarget.value)} disabled={busy} autoComplete="off" spellCheck={false} />
      <button type="submit" disabled={busy || !OPAQUE_ID.test(knownReviewId.trim())}>Reopen known review case</button>
    </form>
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
        <div><dt>This page's identity</dt><dd data-identity={principalId ?? "unknown"}><code>{principalId ?? "unknown"}</code></dd></div>
      </dl>
      {review.note && <p>{review.note}</p>}
      <h6 id="review-assignments-title">Reviewer assignments</h6>
      {review.assignments.length === 0 ? <p>No reviewer is assigned. Only an assigned reviewer can record a decision.</p>
        : <ul aria-labelledby="review-assignments-title">{review.assignments.map((assignment) => <li key={assignment.assignmentId} data-assignment-status={assignment.status}>
          <code>{assignment.reviewerPrincipalId}</code> · {assignment.scopes.join(", ")} · {assignment.status} · expires {assignment.expiresAt} · v{assignment.assignmentVersion}
          {canManage && assignment.status === "ACTIVE" && <> <button type="button" onClick={() => void revoke(assignment)} disabled={busy || locked}
            aria-label={`Revoke ${assignment.reviewerPrincipalId} assignment`}>Revoke</button></>}
        </li>)}</ul>}
      {review.records.length === 0 ? <p>No comments or decisions yet.</p> : <ol aria-label="Review records">{review.records.map((record) => <li key={record.appendRecordId}>
        #{record.caseRevision} · {record.kind === "COMMENT" ? `comment (${record.disposition ?? "OPEN"})` : `DEV_ONLY decision ${record.decision ?? ""}`} · {record.currentness}
        {record.kind === "DECISION" && <span data-recorded-as={record.recordedAs ?? ""}> · recorded as <code>{record.recordedAs ?? "DEV_ONLY"}</code>{record.scope ? ` · scope ${record.scope}` : ""}{record.principalId ? ` · by ${record.principalId}` : ""}</span>}
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
      {canManage && <form id="review-assign-form" onSubmit={(event) => void submitAssign(event)}>
        <fieldset aria-labelledby="review-assign-legend">
          <legend id="review-assign-legend">Assign a DEV_ONLY reviewer (owner only)</legend>
          <label htmlFor="review-assign-principal">Reviewer principal ID</label>
          <input id="review-assign-principal" value={reviewerId} onChange={(event) => setReviewerId(event.currentTarget.value)} disabled={busy || locked} autoComplete="off" spellCheck={false} />
          <fieldset aria-label="Reviewer scopes">
            {DEV_REVIEW_SCOPES.map((value) => <label key={value}><input type="checkbox" value={value} checked={assignScopes.includes(value)}
              onChange={(event) => toggleScope(value, event.currentTarget.checked)} disabled={busy || locked} /> {value}</label>)}
          </fieldset>
          <label htmlFor="review-assign-days">Expires in days (1 to 30)</label>
          <input id="review-assign-days" inputMode="numeric" value={expiryDays} onChange={(event) => setExpiryDays(event.currentTarget.value)} disabled={busy || locked} />
          {!daysOk && <p role="note">Expiry must be a whole number of days from 1 to 30.</p>}
          <p role="note">The owner cannot assign themselves and cannot decide on this case. The assigned principal connects with their own DEV_ONLY token and opens this case by its ID.</p>
          <button type="submit" disabled={assignDisabled}>Assign reviewer</button>
        </fieldset>
      </form>}
      <form id="review-decision-form" onSubmit={(event) => void submitDecision(event)}>
        <label htmlFor="review-decision">Decision</label>
        <select id="review-decision" value={decision} onChange={(event) => { setDecision(event.currentTarget.value as DevReviewDecision); setConfirmed(false); }} disabled={busy || decisionsOff}>
          {DECISIONS.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <label htmlFor="review-scope">Scope</label>
        <select id="review-scope" value={effectiveScope} onChange={(event) => { setScope(event.currentTarget.value as DevReviewScope | ""); setConfirmed(false); }} disabled={busy || decisionsOff} required>
          <option value="">Choose an assigned scope</option>
          {allowedScopes.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <label htmlFor="review-reason">Reason</label>
        <input id="review-reason" value={reason} onChange={(event) => setReason(event.currentTarget.value)} disabled={busy || decisionsOff} required />
        <label htmlFor="review-confirm"><input id="review-confirm" type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)} disabled={busy || decisionsOff} />
          I confirm this records a DEV_ONLY {decision} decision on this exact version only. It is not human approval.</label>
        {gate && !gate.allowed && <p role="note" data-decision-gate={gate.reason}>{gate.text}</p>}
        {stale && <p role="note">Decisions are disabled because this case is STALE. Open a review case on the new exact version.</p>}
        <button type="submit" disabled={busy || decisionsOff || !confirmed || reason.trim() === "" || effectiveScope === "" || review.currentness !== "CURRENT"}>Record DEV_ONLY decision</button>
      </form>
    </article>}
  </section>;
}
