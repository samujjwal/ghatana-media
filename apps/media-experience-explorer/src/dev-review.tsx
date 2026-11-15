import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createDevReviewClient, DevReviewHostError, type DevReviewClient } from "./dev-review-client";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const origin = window.location.origin;
const byId = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing page element: ${id}`);
  return node as T;
};
const tokenInput = byId<HTMLInputElement>("dev-token");
const connectButton = byId<HTMLFormElement>("connect-form").querySelector<HTMLButtonElement>("button[type=submit]")!;
const disconnectButton = byId<HTMLButtonElement>("disconnect");
const status = byId<HTMLParagraphElement>("connection-status");
const root: Root = createRoot(byId<HTMLDivElement>("review-root"));
let bearerToken: string | null = null;

const requestId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** The review state of one version in words a reader can act on; the code stays in `data-state`. */
function describeState(version: Json): string {
  const head = version.head ? "current version" : "superseded";
  switch (version.state) {
    case "NOT_REVIEWED": return "Not reviewed. This version needs its own review.";
    case "NOT_ASSIGNED": return "Not assigned to you.";
    case "IN_REVIEW": return version.superseded ? "In review, but superseded: decisions are no longer accepted." : "In review: no decision yet.";
    case "ACCEPT_CURRENT": return `Accepted by an assigned reviewer (${version.latestScope ?? "scope n/a"}), ${head}.`;
    case "ACCEPT_STALE": return `Earlier acceptance is STALE: a newer version exists. It does not apply to the newer version.`;
    default: return `${String(version.state).replace(/_/gu, " ").toLowerCase()} (${head}).`;
  }
}

function ErrorAlert({ error }: { error: DevReviewHostError | null }): React.ReactElement | null {
  if (!error) return null;
  return <div role="alert" data-error-code={error.code} data-http-status={error.status}><strong>{error.code}</strong>: {error.message}</div>;
}

function Panel({ client }: { client: DevReviewClient }): React.ReactElement {
  const [principal, setPrincipal] = useState("");
  const [assigned, setAssigned] = useState<Json[]>([]);
  const [lineage, setLineage] = useState<Json | null>(null);
  const [kase, setCase] = useState<Json | null>(null);
  const [error, setError] = useState<DevReviewHostError | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(0);
  const shownCase = useRef<string | null>(null);
  const [message, setMessage] = useState("");
  const [playback, setPlayback] = useState("");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [caseIdInput, setCaseIdInput] = useState("");
  const [lineageIdInput, setLineageIdInput] = useState("");
  const [commentText, setCommentText] = useState("");
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState("1");
  const [decision, setDecision] = useState("ACCEPT");
  const [scope, setScope] = useState("APPROVAL");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [reviewerId, setReviewerId] = useState("");
  const [scopes, setScopes] = useState<string[]>(["QUALITY", "APPROVAL"]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  const guard = useCallback(async (work: () => Promise<void>) => {
    setError(null);
    pending.current += 1;
    setBusy(true);
    try { await work(); } catch (failure) {
      setError(failure instanceof DevReviewHostError ? failure : new DevReviewHostError("UNEXPECTED", 0, String(failure)));
    } finally { pending.current -= 1; if (pending.current === 0) setBusy(false); }
  }, []);

  const loadCase = useCallback(async (caseId: string) => {
    await guard(async () => {
      const found = (await client.getCase(caseId)).body;
      setCase(found);
      if (shownCase.current !== caseId) { setVideoUrl(null); setPlayback(""); } // the player survives comments and decisions on the same version
      shownCase.current = caseId;
      const versions = (await client.getVersions(caseId)).body;
      setLineage(versions.lineageId ? versions : null);
      setMessage(`Opened the review of version ${found.lineage?.versionNumber ?? 1}.`);
      queueMicrotask(() => titleRef.current?.focus());
    });
  }, [client, guard]);

  useEffect(() => {
    void guard(async () => {
      setPrincipal(String(((await client.getContext()).body as Json).principalId ?? ""));
      setAssigned(((await client.listAssigned()).body as Json).assignedToMe ?? []);
    });
  }, [client, guard]);

  const refresh = async (caseId: string): Promise<void> => { await loadCase(caseId); };

  const showLineage = (): Promise<void> => guard(async () => {
    const found = (await client.getLineage(lineageIdInput.trim())).body;
    setLineage(found);
    setCase(null);
    setMessage(`Lineage ${found.lineageId}: ${found.versions.length} version(s).`);
  });

  const startReview = (version: Json): Promise<void> => guard(async () => {
    const opened = (await client.openReview(version.artifactId, version.artifactVersionId)).body;
    await loadCase(opened.reviewCaseId);
    if (lineageIdInput.trim()) setLineage((await client.getLineage(lineageIdInput.trim())).body);
  });

  const loadVideo = (): Promise<void> => guard(async () => {
    if (!kase) return;
    setPlayback("Loading the exact version…");
    const { bytes, contentType } = await client.readContent(kase.reviewCaseId);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    const expected = String(kase.subject.artifactVersionId).replace(/^sha256:/u, "");
    if (hex !== expected) { setPlayback(`Refused: the bytes do not match the version (${hex}).`); return; }
    setVideoUrl(URL.createObjectURL(new Blob([bytes], { type: contentType })));
    setPlayback(`Bytes verified against the registered version sha256:${hex}`);
  });

  const addComment = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!kase) return;
    await guard(async () => {
      const startMs = Math.round(Number(start) * 1000);
      const endMs = Math.round(Number(end) * 1000);
      await client.comment(kase.reviewCaseId, { requestId: requestId("comment"), expectedCaseRevision: kase.caseRevision, text: commentText,
        disposition: "OPEN", annotation: { timeRange: { start: ms(startMs), end: ms(endMs) } } });
      setCommentText("");
      await refresh(kase.reviewCaseId);
      setMessage("Comment recorded on this exact version.");
    });
  };

  const decide = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!kase) return;
    await guard(async () => {
      await client.decide(kase.reviewCaseId, { requestId: requestId("decision"), expectedCaseRevision: kase.caseRevision, decision, reason, confirmed, scope });
      await refresh(kase.reviewCaseId);
      setMessage(`Decision ${decision} recorded for this exact version (DEV_ONLY, not an approval).`);
    });
  };

  const assign = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!kase) return;
    await guard(async () => {
      await client.assign(kase.reviewCaseId, { requestId: requestId("assign"), expectedCaseRevision: kase.caseRevision, reviewerPrincipalId: reviewerId.trim(),
        scopes, expiresAt: new Date(Date.now() + 2 * 3600_000).toISOString().replace(/\.\d+Z$/u, "Z") });
      await refresh(kase.reviewCaseId);
      setMessage(`Reviewer ${reviewerId.trim()} assigned to this exact version.`);
    });
  };

  const comments: Json[] = (kase?.records ?? []).filter((record: Json) => record.kind === "COMMENT");
  const decisions: Json[] = (kase?.records ?? []).filter((record: Json) => record.kind === "DECISION");
  const isOwner = kase?.role === "OWNER";

  return (
    <section className="review-block" aria-labelledby="review-heading" data-review-panel>
      <h2 id="review-heading">Versioned review</h2>
      <p data-principal>{principal ? `Signed in as ${principal} (DEV_ONLY test identity).` : "Reading identity…"}</p>
      <p id="review-status" role="status" aria-live="polite" data-status-line>{message}</p>
      <ErrorAlert error={error} />

      <form onSubmit={(event) => { event.preventDefault(); void loadCase(caseIdInput.trim()); }} aria-label="Open a review case">
        <div className="review-field"><label htmlFor="review-case-id">Review case id</label>
          <input id="review-case-id" value={caseIdInput} onChange={(event) => setCaseIdInput(event.target.value)} autoComplete="off" /></div>
        <button type="submit">Open review case</button>
      </form>
      <form onSubmit={(event) => { event.preventDefault(); void showLineage(); }} aria-label="Show the versions of a lineage">
        <div className="review-field"><label htmlFor="review-lineage-id">Lineage id (uploader)</label>
          <input id="review-lineage-id" value={lineageIdInput} onChange={(event) => setLineageIdInput(event.target.value)} autoComplete="off" /></div>
        <button type="submit">Show versions</button>
      </form>

      <div className="review-scroll" tabIndex={0} role="region" aria-label="Reviews assigned to me">
        <table data-assigned-table><caption>Reviews assigned to me</caption>
          <thead><tr><th scope="col">Case</th><th scope="col">Version</th><th scope="col">Assignment</th><th scope="col">Open</th></tr></thead>
          <tbody>{assigned.length === 0 ? <tr><td colSpan={4}>No assigned reviews.</td></tr> : assigned.map((row) => (
            <tr key={row.reviewCaseId} data-case-id={row.reviewCaseId}>
              <td><code>{row.reviewCaseId}</code></td><td><code>{row.subject.artifactVersionId.slice(0, 19)}…</code></td>
              <td>{row.myAssignments.map((a: Json) => `${a.status} (${a.scopes.join(", ")})`).join("; ")}</td>
              <td><button type="button" onClick={() => void loadCase(row.reviewCaseId)}>Open this review</button></td>
            </tr>))}</tbody></table>
      </div>

      {lineage ? (
        <div className="review-scroll" tabIndex={0} role="region" aria-label="Version switcher">
          <table data-version-table><caption>Versions of lineage {lineage.lineageId}: review state per exact version</caption>
            <thead><tr><th scope="col">Version</th><th scope="col">Review state</th><th scope="col">Comments</th><th scope="col">Action</th></tr></thead>
            <tbody>{lineage.versions.map((version: Json) => {
              const current = kase && kase.subject.artifactVersionId === version.artifactVersionId;
              return (
                <tr key={version.artifactVersionId} data-version-number={version.versionNumber} data-state={version.state} data-head={String(version.head)}
                  data-accepted-for-head={String(version.acceptedForHead)} aria-current={current ? "true" : undefined}>
                  <th scope="row">v{version.versionNumber}{version.head ? " (current)" : ""}</th>
                  <td><span className="review-state" data-stale={String(version.state.endsWith("_STALE"))}>{describeState(version)}</span></td>
                  <td>{version.commentCount}</td>
                  <td>{version.reviewCaseId && version.state !== "NOT_REVIEWED" ? (
                    <button type="button" onClick={() => void loadCase(version.reviewCaseId)}>Review version {version.versionNumber}</button>
                  ) : lineage.role === "OWNER" && version.head ? (
                    <button type="button" onClick={() => void startReview(version)}>Start review of version {version.versionNumber}</button>
                  ) : "—"}</td>
                </tr>);
            })}</tbody></table>
        </div>
      ) : null}

      {kase ? (
        <article data-case-panel data-case-id={kase.reviewCaseId} data-currentness={kase.currentness} data-role={kase.role}>
          <h3 id="review-case-title" tabIndex={-1} ref={titleRef}>Review of version {kase.lineage?.versionNumber ?? 1}</h3>
          <dl>
            <dt>Your role</dt><dd data-role-text>{isOwner ? "Uploader (owner): may comment and assign, may not decide" : "Assigned reviewer"}</dd>
            <dt>Exact version</dt><dd><code>{kase.subject.artifactVersionId}</code></dd>
            <dt>Currentness</dt><dd data-currentness-text>{kase.currentness}{kase.lineage?.superseded ? " (a newer version exists)" : ""}</dd>
            <dt>Latest decision</dt><dd data-latest-status>{kase.reviewState.status}</dd>
            <dt>Establishes approval</dt><dd>No (DEV_ONLY)</dd>
          </dl>

          <h4>Player</h4>
          <button type="button" onClick={() => void loadVideo()}>Load the exact version (verified)</button>
          <p data-playback-status role="status" aria-live="polite">{playback}</p>
          {videoUrl ? <video ref={videoRef} src={videoUrl} controls aria-label={`Version ${kase.lineage?.versionNumber ?? 1}`} data-verified-review-video /> : null}

          <div className="review-scroll" tabIndex={0} role="region" aria-label="Time-coded comments">
            <table data-comments><caption>Time-coded comments</caption>
              <thead><tr><th scope="col">When</th><th scope="col">Comment</th><th scope="col">By</th><th scope="col">Go to</th></tr></thead>
              <tbody>{comments.length === 0 ? <tr><td colSpan={4}>No comments on this version.</td></tr> : comments.map((record) => {
                const range = record.annotation?.timeRange;
                const startMs = range ? (range.start.ticks * 1000 * range.start.rateDenominator) / range.start.rateNumerator : null;
                const endMs = range ? (range.end.ticks * 1000 * range.end.rateDenominator) / range.end.rateNumerator : null;
                return (
                  <tr key={record.appendRecordId} data-start-ms={startMs ?? ""} data-end-ms={endMs ?? ""}>
                    <td>{startMs === null ? "whole video" : `${seconds(startMs)} – ${seconds(endMs as number)}`}</td>
                    <td>{record.text}</td><td>{record.principalId}</td>
                    <td>{startMs === null ? "—" : <button type="button" onClick={() => { if (videoRef.current) videoRef.current.currentTime = startMs / 1000; }} disabled={!videoUrl}>Seek to {seconds(startMs)}</button>}</td>
                  </tr>);
              })}</tbody></table>
          </div>

          <form onSubmit={(event) => void addComment(event)} aria-label="Add a time-coded comment">
            <div className="review-field"><label htmlFor="review-comment-text">Comment</label>
              <textarea id="review-comment-text" required rows={2} value={commentText} onChange={(event) => setCommentText(event.target.value)} /></div>
            <div className="review-field"><label htmlFor="review-comment-start">Start (seconds)</label>
              <input id="review-comment-start" inputMode="decimal" value={start} onChange={(event) => setStart(event.target.value)} /></div>
            <div className="review-field"><label htmlFor="review-comment-end">End (seconds)</label>
              <input id="review-comment-end" inputMode="decimal" value={end} onChange={(event) => setEnd(event.target.value)} /></div>
            <button type="button" onClick={() => { const now = videoRef.current?.currentTime ?? 0; setStart(now.toFixed(1)); setEnd((now + 1).toFixed(1)); }}>Use the current video time</button>
            <button type="submit" disabled={busy}>Add comment</button>
          </form>

          <div className="review-scroll" tabIndex={0} role="region" aria-label="Decisions">
            <table data-decisions><caption>Decisions on this exact version</caption>
              <thead><tr><th scope="col">Decision</th><th scope="col">Scope</th><th scope="col">By</th><th scope="col">Recorded as</th><th scope="col">Currentness</th></tr></thead>
              <tbody>{decisions.length === 0 ? <tr><td colSpan={5}>No decisions yet.</td></tr> : decisions.map((record) => (
                <tr key={record.appendRecordId} data-decision={record.decision} data-currentness={record.currentness}>
                  <td>{record.decision}</td><td>{record.scope ?? "—"}</td><td>{record.principalId}</td><td>{record.recordedAs}</td><td>{record.currentness}</td></tr>))}</tbody></table>
          </div>

          <form onSubmit={(event) => void decide(event)} aria-label="Record a decision">
            <div className="review-field"><label htmlFor="review-decision">Decision</label>
              <select id="review-decision" value={decision} onChange={(event) => setDecision(event.target.value)}>
                {["ACCEPT", "REQUEST_CHANGES", "REJECT", "DEFER"].map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
            <div className="review-field"><label htmlFor="review-scope">Scope</label>
              <select id="review-scope" value={scope} onChange={(event) => setScope(event.target.value)}>
                {["APPROVAL", "QUALITY", "RIGHTS", "PROVENANCE"].map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
            <div className="review-field"><label htmlFor="review-reason">Reason</label>
              <textarea id="review-reason" required rows={2} value={reason} onChange={(event) => setReason(event.target.value)} /></div>
            <div className="review-field"><label htmlFor="review-confirm">I confirm this decision is for this exact version only</label>
              <input id="review-confirm" type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /></div>
            <button type="submit" disabled={busy}>Record decision</button>
          </form>

          {isOwner ? (
            <form onSubmit={(event) => void assign(event)} aria-label="Assign a reviewer">
              <div className="review-field"><label htmlFor="review-reviewer">Reviewer principal id</label>
                <input id="review-reviewer" required value={reviewerId} onChange={(event) => setReviewerId(event.target.value)} autoComplete="off" /></div>
              <fieldset><legend>Scopes the reviewer may decide</legend>
                {["QUALITY", "RIGHTS", "PROVENANCE", "APPROVAL"].map((value) => (
                  <div className="review-field" key={value}><label htmlFor={`review-scope-${value}`}>{value}</label>
                    <input id={`review-scope-${value}`} type="checkbox" checked={scopes.includes(value)}
                      onChange={(event) => setScopes(event.target.checked ? [...scopes, value] : scopes.filter((s) => s !== value))} /></div>))}
              </fieldset>
              <button type="submit" disabled={busy}>Assign reviewer for 2 hours</button>
            </form>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}

function ms(totalMs: number): Json {
  return { ticks: totalMs, rateNumerator: 1000, rateDenominator: 1, clock: "SOURCE_PRESENTATION" };
}

const forget = (): void => { bearerToken = null; root.render(null); };
byId<HTMLFormElement>("connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = tokenInput.value.trim();
  if (!raw) return;
  bearerToken = raw;
  tokenInput.value = "";
  tokenInput.disabled = true;
  connectButton.disabled = true;
  disconnectButton.disabled = false;
  status.textContent = "Validating DEV_ONLY identity…";
  try {
    const response = await fetch(`${origin}/dev/v1/context`, { headers: { Authorization: `Bearer ${bearerToken}` } });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "DEV_ONLY identity was denied." : `Host context failed (${response.status}).`);
    const context: unknown = await response.json();
    if (!context || typeof context !== "object" || (context as { scope?: unknown }).scope !== "DEV_ONLY") throw new TypeError("Host returned an invalid DEV_ONLY context.");
    status.textContent = "Connected to local DEV_ONLY host. Each route is subject to the host's owner and reviewer authority.";
    root.render(<Panel client={createDevReviewClient({ origin, bearerToken: () => bearerToken ?? "" })} />);
  } catch (error) {
    forget();
    status.textContent = error instanceof Error ? error.message : "Unable to connect.";
    tokenInput.disabled = false; connectButton.disabled = false; disconnectButton.disabled = true;
  }
});
disconnectButton.addEventListener("click", () => {
  forget();
  tokenInput.disabled = false; connectButton.disabled = false; disconnectButton.disabled = true;
  status.textContent = "Disconnected. In-memory token cleared.";
});
window.addEventListener("beforeunload", forget);
