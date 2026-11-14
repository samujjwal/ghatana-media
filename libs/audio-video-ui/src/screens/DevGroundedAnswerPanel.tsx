import React from "react";
import {
  DevGroundedHostError, boxPercent, describeGroundedFailure, formatSeconds, parseGroundedAnswerView, playerSeconds,
  type DevGroundedAnswerPort, type GroundedAnswerView, type GroundedEvidence, type GroundedFailure,
} from "./devGroundedAnswer";
import { DevContentError, describeContentFailure, readVerifiedContent, type DevArtifactContentReader } from "./devArtifactContent";

export interface DevGroundedAnswerPanelProps {
  readonly answers: DevGroundedAnswerPort;
  readonly locked?: boolean;
  /** Injectable for deterministic tests; must return a fresh opaque id per call. */
  readonly newRequestId?: () => string;
}

type Source = { readonly state: "none" | "loading" | "ready" | "failed"; readonly url?: string; readonly message?: string };
type Active = { readonly evidenceId: string; readonly seconds: number; readonly sought: boolean; readonly note: string } | null;

let counter = 0;
const defaultRequestId = (): string => {
  const random = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${(counter++).toString(36)}`;
  return `ui-${random}`;
};
const asHost = (error: unknown): DevGroundedHostError => error instanceof DevGroundedHostError ? error
  : new DevGroundedHostError("INVALID_RESPONSE", 200, error instanceof Error ? error.message : "Invalid response.");
const KIND_LABEL: Readonly<Record<GroundedEvidence["kind"], string>> = {
  TRANSCRIPT_SEGMENT: "Spoken", FRAME: "Frame caption", FRAME_OBJECT: "Detected object", FRAME_TEXT: "On-screen text",
};
const STATUS_TEXT: Readonly<Record<GroundedAnswerView["status"], string>> = {
  GROUNDED: "Every claim cites valid evidence", PARTIALLY_GROUNDED: "Some claims cite valid evidence; others are not grounded",
  UNGROUNDED: "No claim cites valid evidence", ANSWER_UNPARSEABLE: "The model reply could not be read; no claim is shown",
};

/**
 * DEV_ONLY grounded answer view. Each grounded claim lists its citations as buttons; activating one seeks the source
 * player to that evidence's time on the source clock and highlights the cited box or text (frame evidence) or the
 * spoken line (transcript evidence). Claims that are uncited, cite unknown evidence or fail range checks are listed
 * separately as NOT grounded and never get a seek control. "Grounded" means the citations are valid; it is not a claim
 * that the answer is true.
 */
export function DevGroundedAnswerPanel({ answers, locked = false, newRequestId = defaultRequestId }: DevGroundedAnswerPanelProps): React.ReactElement {
  const id = React.useId();
  const [form, setForm] = React.useState({ artifactId: "", artifactVersionId: "", question: "", reopenId: "" });
  const [view, setView] = React.useState<GroundedAnswerView | null>(null);
  const [via, setVia] = React.useState<"created" | "replayed" | "reopened">("created");
  const [message, setMessage] = React.useState("Nothing requested.");
  const [failure, setFailure] = React.useState<GroundedFailure | null>(null);
  const [pending, setPending] = React.useState(false);
  const [source, setSource] = React.useState<Source>({ state: "none" });
  const [active, setActive] = React.useState<Active>(null);
  const [announce, setAnnounce] = React.useState("");
  const attempt = React.useRef<{ fingerprint: string; requestId: string } | null>(null);
  const video = React.useRef<HTMLVideoElement | null>(null);
  const pendingSeek = React.useRef<number | null>(null);
  const disabled = locked || pending;
  const reader: DevArtifactContentReader | undefined = answers.readArtifactContent
    ? { readArtifactContent: (request) => answers.readArtifactContent!(request) } : undefined;

  React.useEffect(() => () => { if (source.url) URL.revokeObjectURL(source.url); }, [source.url]);

  async function loadSource(next: GroundedAnswerView): Promise<void> {
    if (!reader) { setSource({ state: "failed", message: "No source content reader is configured, so citations cannot seek a player." }); return; }
    setSource({ state: "loading" });
    try {
      const content = await readVerifiedContent(reader, { artifactId: next.source.artifactId, artifactVersionId: next.source.artifactVersionId,
        contentType: next.source.contentType, sizeBytes: null, sha256: next.source.sha256 });
      const copy = new Uint8Array(content.bytes.byteLength);
      copy.set(content.bytes);
      setSource({ state: "ready", url: URL.createObjectURL(new Blob([copy.buffer], { type: next.source.contentType })) });
    } catch (error) {
      setSource({ state: "failed", message: error instanceof DevContentError ? describeContentFailure(error).text : "The source video could not be loaded and verified." });
    }
  }

  async function show(next: GroundedAnswerView, how: "created" | "replayed" | "reopened"): Promise<void> {
    setView(next); setVia(how); setActive(null); setAnnounce(""); setFailure(null);
    setMessage(how === "created" ? `Created: registered grounded answer ${next.outputId}.`
      : how === "replayed" ? `Replayed: the same request identity returned existing answer ${next.outputId}.` : `Reopened answer ${next.outputId} from the host.`);
    await loadSource(next);
  }

  async function ask(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (disabled) return;
    const fingerprint = JSON.stringify([form.artifactId, form.artifactVersionId, form.question.trim()]);
    if (!form.artifactId.trim() || !/^sha256:[0-9a-f]{64}$/u.test(form.artifactVersionId.trim()) || !form.question.trim() || form.question.length > 200) {
      setMessage("Enter the source artifact id, its exact sha256: version and a question of at most 200 characters. Nothing was sent.");
      return;
    }
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, requestId: newRequestId() };
    setPending(true); setFailure(null); setView(null); setActive(null); setAnnounce(""); setSource({ state: "none" });
    setMessage("Asking the local models. This can take a minute…");
    try {
      const response = await answers.ask({ requestId: attempt.current.requestId, artifactId: form.artifactId.trim(),
        artifactVersionId: form.artifactVersionId.trim(), question: form.question.trim() });
      if (response.status !== 200 && response.status !== 201) throw new DevGroundedHostError("INVALID_RESPONSE", response.status, "Unexpected success status.");
      const parsed = parseGroundedAnswerView(response.body);
      if ((response.status === 200) !== parsed.replayed) throw new DevGroundedHostError("INVALID_RESPONSE", response.status, "Status and replay flag disagree.");
      await show(parsed, parsed.replayed ? "replayed" : "created");
    } catch (error) {
      const outcome = describeGroundedFailure(asHost(error));
      setFailure(outcome); setMessage(`${outcome.code}: ${outcome.text}`);
    } finally { setPending(false); }
  }

  async function reopen(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (disabled || !form.reopenId.trim()) return;
    setPending(true); setFailure(null); setView(null); setActive(null); setAnnounce(""); setSource({ state: "none" });
    setMessage("Reopening…");
    try {
      const response = await answers.get(form.reopenId.trim());
      if (response.status !== 200) throw new DevGroundedHostError("INVALID_RESPONSE", response.status, "Unexpected success status.");
      await show(parseGroundedAnswerView(response.body, { outputId: form.reopenId.trim() }), "reopened");
    } catch (error) {
      const outcome = describeGroundedFailure(asHost(error));
      setFailure(outcome); setMessage(`${outcome.code}: ${outcome.text}`);
    } finally { setPending(false); }
  }

  function cite(item: GroundedEvidence): void {
    if (!view) return;
    const seconds = playerSeconds(item, view.clock);
    const element = video.current;
    let sought = false;
    let note = element && source.state === "ready" ? "" : "source video not available to seek";
    if (element && source.state === "ready") {
      const ranges = element.readyState >= 1 ? element.seekable : null;
      const start = ranges && ranges.length > 0 ? ranges.start(0) : null;
      const end = ranges && ranges.length > 0 ? ranges.end(ranges.length - 1) : null;
      // A player may expose a shorter or shifted timeline than the container clock (for example a non-zero start_time):
      // never clamp silently; say that this evidence is outside what the player can reach.
      if (start !== null && end !== null && (seconds < start - 0.05 || seconds > end + 0.05)) {
        note = `outside the player's seekable range ${formatSeconds(start)}–${formatSeconds(end)}`;
      } else if (element.readyState >= 1) { element.currentTime = seconds; sought = true; }
      else { pendingSeek.current = seconds; sought = true; }
      element.pause();
    }
    setActive({ evidenceId: item.evidenceId, seconds, sought, note });
    const box = boxPercent(item);
    setAnnounce(`${sought ? "Player moved to" : "Citation at"} ${formatSeconds(seconds)}${note ? ` (${note})` : ""}. ${KIND_LABEL[item.kind]} ${item.evidenceId}: ${item.text}.${box ? " The cited region is highlighted on the video." : ""}`);
  }

  const evidenceById = React.useMemo(() => new Map((view?.evidence ?? []).map((item) => [item.evidenceId, item])), [view]);
  const activeItem = active ? evidenceById.get(active.evidenceId) ?? null : null;
  const overlay = activeItem ? boxPercent(activeItem) : null;

  return <section aria-labelledby={`${id}-title`} className="dev-grounded-answer">
    <h2 id={`${id}-title`}>Grounded answer · DEV_ONLY</h2>
    <aside role="note"><p>Local open-model output about one exact source version. Each claim lists the evidence it cites; the host checked that the cited ids exist, were offered to the model, and lie inside the source clock and frame. That is citation integrity, not proof the claim is true, and no quality, rights or approval claim is made.</p></aside>

    <form onSubmit={ask} aria-label="Ask a question about a video" className="ga-ask">
      <label htmlFor={`${id}-artifact`}>Source video artifact ID</label>
      <input id={`${id}-artifact`} type="text" value={form.artifactId} disabled={disabled} autoComplete="off" onChange={(e) => setForm({ ...form, artifactId: e.currentTarget.value })} />
      <label htmlFor={`${id}-version`}>Exact source version (sha256:…)</label>
      <input id={`${id}-version`} type="text" value={form.artifactVersionId} disabled={disabled} autoComplete="off" onChange={(e) => setForm({ ...form, artifactVersionId: e.currentTarget.value })} />
      <label htmlFor={`${id}-question`}>Question about the video (at most 200 characters)</label>
      <input id={`${id}-question`} type="text" maxLength={200} value={form.question} disabled={disabled} autoComplete="off" onChange={(e) => setForm({ ...form, question: e.currentTarget.value })} />
      <button type="submit" disabled={disabled}>Ask with citations</button>
    </form>
    <form onSubmit={reopen} aria-label="Reopen a grounded answer" className="ga-reopen">
      <label htmlFor={`${id}-reopen`}>Reopen answer by output ID</label>
      <input id={`${id}-reopen`} type="text" value={form.reopenId} disabled={disabled} autoComplete="off" onChange={(e) => setForm({ ...form, reopenId: e.currentTarget.value })} />
      <button type="submit" disabled={disabled || !form.reopenId.trim()}>Reopen</button>
    </form>
    <p role={failure ? "alert" : "status"} aria-live={failure ? "assertive" : "polite"} id="grounded-status" data-tone={failure?.tone ?? "idle"}>{message}</p>

    {view && <article id="grounded-result" aria-labelledby={`${id}-result`} data-output-id={view.outputId} data-status={view.status} data-via={via}>
      <h3 id={`${id}-result`}>Answer to “{view.question}”</h3>
      <p data-testid="answer-status"><strong>{view.status.replaceAll("_", " ")}</strong> · {STATUS_TEXT[view.status]}{view.evidenceCompleteness === "PARTIAL" ? " · evidence is PARTIAL: a child did not complete" : ""}</p>

      <div className="ga-layout">
        <div className="ga-player">
          <h4>Source video</h4>
          {source.state === "loading" && <p role="status">Reading and verifying the exact source version…</p>}
          {source.state === "failed" && <p role="alert">{source.message} Citations still show their evidence but cannot seek.</p>}
          {source.state === "ready" && source.url && <div className="ga-frame" data-testid="player-frame">
            <video ref={video} src={source.url} controls preload="auto" aria-label="Source video for the grounded answer"
              onLoadedMetadata={(e) => { if (pendingSeek.current !== null) { e.currentTarget.currentTime = pendingSeek.current; pendingSeek.current = null; } }} />
            {overlay && activeItem && <div className="ga-box" data-testid="citation-box" data-evidence-id={activeItem.evidenceId} role="img"
              aria-label={`Highlighted region for ${activeItem.evidenceId}: ${activeItem.text}`}
              ref={(node) => { if (node) { node.style.left = `${overlay.left}%`; node.style.top = `${overlay.top}%`; node.style.width = `${overlay.width}%`; node.style.height = `${overlay.height}%`; } }} />}
          </div>}
          <p>Citation times are container-clock (PTS) times; this source starts at {formatSeconds(view.clock.containerStartMicros / 1_000_000)}. Clock <code>{view.clock.clockId}</code>.</p>
        </div>

        <div className="ga-claims">
          <h4>Grounded claims</h4>
          {view.claims.length === 0 ? <p>No claim cites valid evidence.</p> : <ol aria-label="Grounded claims">{view.claims.map((claim) => <li key={claim.claimId} data-claim-id={claim.claimId}>
            <p>{claim.text}</p>
            <ul aria-label={`Citations for claim ${claim.claimId}`} className="ga-citations">{claim.evidenceIds.map((evidenceId) => {
              const item = evidenceById.get(evidenceId)!;
              const on = active?.evidenceId === evidenceId;
              return <li key={evidenceId}><button type="button" data-evidence-id={evidenceId} aria-pressed={on}
                aria-label={`${KIND_LABEL[item.kind]} citation ${evidenceId} at ${formatSeconds(playerSeconds(item, view.clock))}: ${item.text}. Seek the video to this evidence`}
                onClick={() => cite(item)}>{evidenceId} · {formatSeconds(playerSeconds(item, view.clock))}</button></li>;
            })}</ul>
          </li>)}</ol>}

          <h4>Not grounded</h4>
          {view.notGrounded.length === 0 ? <p>No claim was flagged.</p> : <ul aria-label="Claims that are not grounded" className="ga-flagged">{view.notGrounded.map((claim, index) =>
            <li key={index} data-flagged="true"><p><strong>NOT GROUNDED</strong> · {claim.text || "(empty claim)"}</p>
              <p>Reason: {claim.flags.join(", ")} ({claim.by === "host" ? "checked by the host" : "checked again in this page"}). It has no seek control.</p></li>)}</ul>}

          <h4>Evidence children</h4>
          <table aria-label="Evidence children"><thead><tr><th scope="col">Child</th><th scope="col">Status</th><th scope="col">Evidence</th></tr></thead>
            <tbody>{view.children.map((child) => <tr key={child.kind}><th scope="row">{child.kind.replaceAll("_", " ")}</th>
              <td>{child.status}{child.reason ? ` · ${child.reason}` : ""}</td><td>{child.evidenceCount}</td></tr>)}</tbody></table>
        </div>
      </div>

      <h4>Evidence</h4>
      <ul aria-label="Evidence" className="ga-evidence">{view.evidence.map((item) => <li key={item.evidenceId} data-evidence-id={item.evidenceId}
        aria-current={active?.evidenceId === item.evidenceId ? "true" : undefined} data-active={active?.evidenceId === item.evidenceId ? "true" : "false"}>
        <code>{item.evidenceId}</code> · {KIND_LABEL[item.kind]} · {formatSeconds(playerSeconds(item, view.clock))}{item.kind === "TRANSCRIPT_SEGMENT" ? `–${formatSeconds(playerSeconds({ startMicros: item.endMicros }, view.clock))}` : ""}
        {item.box ? ` · box ${Math.round(item.box.x)},${Math.round(item.box.y)} ${Math.round(item.box.width)}×${Math.round(item.box.height)}` : ""} · {item.text}</li>)}</ul>
      <p className="ga-sr-only" role="status" aria-live="polite" data-testid="citation-announcement">{announce}</p>
      {active && <p data-testid="active-citation" data-evidence-id={active.evidenceId} data-seconds={active.seconds.toFixed(3)}>Active citation <code>{active.evidenceId}</code> at {formatSeconds(active.seconds)}{active.sought ? "" : ` (${active.note})`}.</p>}
    </article>}
  </section>;
}
