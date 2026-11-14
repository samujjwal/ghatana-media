import React from "react";
import type { DevProject, DevProjectRevision } from "@audio-video/client/dev-project-timeline";
import {
  DevOutputsHostError, describeExportFailure, describeRenderFailure, describeReviewFailure, parseExportView, parseRenderView,
  parseReviewReceipt, parseReviewView,
  type DevCommentDisposition, type ExportView, type DevProjectOutputsPort, type DevRenderFormat, type DevReviewDecision,
  type DevReviewSubject, type Outcome, type RenderView, type ReviewView,
} from "./devProjectOutputs";
import { DevReviewSection } from "./DevReviewSection";
import { DevRightsSection } from "./DevRightsSection";
import { DevVerifiedContent } from "./DevVerifiedContent";
import type { DevArtifactContentReader } from "./devArtifactContent";

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

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * Exports exactly one registered render artifact version to a destination. "Delivered" is only ever shown
 * with a destination readback receipt whose digest equals the artifact sha256; HTTP 202 is never delivery.
 * Mounted keyed by artifact version so its state cannot leak to another render.
 */
function DevExportControls({ outputs, view, locked, newRequestId }: {
  readonly outputs: DevProjectOutputsPort; readonly view: RenderView; readonly locked: boolean; readonly newRequestId: () => string;
}): React.ReactElement {
  const [destination, setDestination] = React.useState("");
  const [pending, setPending] = React.useState<"export" | "check" | null>(null);
  const [result, setResult] = React.useState<ExportView | null>(null);
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);
  const [message, setMessage] = React.useState("No export requested.");
  const attempt = React.useRef<Attempt | null>(null);
  const [requested, setRequested] = React.useState(false);

  const destinationOk = OPAQUE_ID.test(destination.trim());
  const busy = pending !== null;
  const expectedFor = (requestId: string, destinationId: string) => ({
    requestId, artifactId: view.artifactId, artifactVersionId: view.artifactVersionId, destinationId,
    sha256: view.sha256, sizeBytes: view.sizeBytes,
  });
  const fail = (error: unknown): void => {
    const next = describeExportFailure(asHost(error));
    if (next.discardRequest) { attempt.current = null; setRequested(false); }
    setResult(null); setOutcome(next); setMessage(`${next.code}: ${next.text}`);
  };
  const accept = (status: number, body: unknown, destinationId: string, requestId: string, allowed: readonly number[]): ExportView => {
    if (!allowed.includes(status)) throw new DevOutputsHostError("INVALID_RESPONSE", status, "Unexpected status.");
    const exported = parseExportView(body, expectedFor(requestId, destinationId));
    if (status === 202 && exported.destinationConfirmed) throw new DevOutputsHostError("INVALID_RESPONSE", status, "HTTP 202 cannot carry a destination confirmation.");
    if ((status === 200 || status === 201) && !exported.destinationConfirmed && allowed.includes(201)) {
      throw new DevOutputsHostError("INVALID_RESPONSE", status, "A 200/201 export response must be destination-confirmed.");
    }
    return exported;
  };
  const show = (exported: ExportView, status: number): void => {
    setResult(exported); setOutcome(null);
    setMessage(exported.destinationConfirmed
      ? `${status === 201 ? "Exported (HTTP 201)" : status === 200 && exported.replayed ? "Replayed or read back (HTTP 200)" : `HTTP ${status}`}: destination confirmed with receipt ${exported.receiptRef}; destination digest matches artifact sha256 ${exported.artifactDigest}.`
      : `NOT CONFIRMED (${exported.status}): no destination receipt exists yet, so this artifact is not delivered. Check again, or retry with the same request identity.`);
  };

  const exportNow = async (): Promise<void> => {
    if (locked || busy || !destinationOk) return;
    const destinationId = destination.trim();
    const fp = `${view.artifactId}|${view.artifactVersionId}|${destinationId}`;
    if (!attempt.current || attempt.current.fingerprint !== fp) attempt.current = { fingerprint: fp, requestId: newRequestId() };
    const requestId = attempt.current.requestId;
    setPending("export"); setOutcome(null); setRequested(true);
    setMessage(`Exporting ${view.artifactVersionId} to destination ${destinationId}…`);
    try {
      const response = await outputs.requestExport({ requestId, artifactId: view.artifactId, artifactVersionId: view.artifactVersionId, destinationId });
      show(accept(response.status, response.body, destinationId, requestId, [200, 201, 202]), response.status);
    } catch (error) { fail(error); } finally { setPending(null); }
  };

  const checkAgain = async (): Promise<void> => {
    if (busy || !attempt.current) return;
    const requestId = attempt.current.requestId;
    const destinationId = attempt.current.fingerprint.split("|")[2] ?? "";
    setPending("check"); setOutcome(null);
    setMessage(`Checking export ${requestId}…`);
    try {
      const response = await outputs.getExport(requestId);
      show(accept(response.status, response.body, destinationId, requestId, [200]), response.status);
    } catch (error) { fail(error); } finally { setPending(null); }
  };

  const confirmed = result?.destinationConfirmed === true;
  return <section aria-labelledby="export-title" id="dev-export" data-export-state={confirmed ? "confirmed" : result ? "unconfirmed" : outcome ? outcome.tone : "idle"}>
    <h6 id="export-title">Export this render artifact</h6>
    <p>Exports exactly <code>{view.artifactVersionId}</code> to a configured DEV_ONLY destination. Delivery is claimed only after the destination returns a readback receipt.</p>
    <form id="export-form" onSubmit={(event) => { event.preventDefault(); void exportNow(); }}>
      <label htmlFor="export-destination">Destination ID</label>
      <input id="export-destination" value={destination} onChange={(event) => setDestination(event.currentTarget.value)} disabled={locked || busy} autoComplete="off" spellCheck={false} />
      {!destinationOk && destination !== "" && <p id="export-destination-help">A destination id is 1-128 letters, digits or . _ : -, starting with a letter or digit.</p>}
      <button type="submit" disabled={locked || busy || !destinationOk}>Export render artifact</button>
      {outcome?.retrySameRequest && requested && <button type="button" onClick={() => void exportNow()} disabled={locked || busy}>Retry export with the same request identity</button>}
      {requested && !confirmed && <button type="button" onClick={() => void checkAgain()} disabled={busy}>Check again</button>}
    </form>
    <p id="export-status" role="status" aria-live="polite" aria-atomic="true" aria-busy={busy}
      data-state={confirmed ? "confirmed" : result ? "unconfirmed" : outcome ? outcome.tone : "idle"}>{message}</p>
    {outcome && <p role="alert" data-outcome={outcome.tone}><strong>{outcome.tone === "unknown" ? "Outcome unknown · not confirmed" : outcome.tone === "denied" ? "Denied" : outcome.tone === "unavailable" ? "Unavailable" : "Not exported"} · <code>{outcome.code}</code></strong></p>}
    {result && <article aria-label="Export result" data-export-request={result.requestId} data-destination-confirmed={String(confirmed)}>
      <h6>{confirmed ? "Delivered with destination receipt" : "Not confirmed · no receipt"}</h6>
      <dl>
        <div><dt>Request identity</dt><dd><code>{result.requestId}</code></dd></div>
        <div><dt>Destination</dt><dd><code>{result.destinationId}</code></dd></div>
        <div><dt>Status</dt><dd><code>{result.status}</code></dd></div>
        {result.acknowledgedBytes !== null && <div><dt>Acknowledged bytes</dt><dd>{result.acknowledgedBytes}</dd></div>}
        {confirmed && <div><dt>Destination receipt</dt><dd><code>{result.receiptRef}</code></dd></div>}
        {confirmed && <div><dt>Destination digest</dt><dd><code>{result.artifactDigest}</code> equals the artifact sha256</dd></div>}
      </dl>
    </article>}
  </section>;
}

/** DEV_ONLY render, review and export controls. A DEV_ONLY review never claims approval; export claims delivery only with a destination receipt. */
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
  const [knownRenderId, setKnownRenderId] = React.useState("");

  const [reviewBusy, setReviewBusy] = React.useState(false);
  const isHead = project.headRevisionId === revision.revisionId;
  const busy = pending !== null || reviewBusy;
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

  const reopenKnownRender = async (): Promise<void> => {
    const renderId = knownRenderId.trim();
    if (busy || !OPAQUE_ID.test(renderId)) return;
    setPending("reopen"); setRenderOutcome(null);
    setRenderMessage(`Reopening known render ${renderId}…`);
    try {
      const response = await outputs.getRender(project.projectId, renderId);
      if (response.status !== 200) throw new DevOutputsHostError("INVALID_RESPONSE", response.status, "Unexpected status.");
      const view = parseRenderView(response.body, { projectId: project.projectId });
      if (view.renderId !== renderId) throw new DevOutputsHostError("INVALID_RESPONSE", 200, "Reopened render does not match the requested render id.");
      setShown({ view, via: "reopened" });
      setKnownRenderId("");
      setRenderMessage(`Reopened render ${view.renderId}: artifact version ${view.artifactVersionId} for revision ${view.revisionId}.`);
    } catch (error) {
      const outcome = describeRenderFailure(asHost(error));
      setRenderOutcome({ ...outcome, retrySameRequest: false });
      setRenderMessage(`${outcome.code}: ${outcome.text}`);
    } finally { setPending(null); }
  };

  const contentReader: DevArtifactContentReader | undefined = outputs.readArtifactContent
    ? { readArtifactContent: (request) => outputs.readArtifactContent!(request) } : undefined;
  const retryRender = renderOutcome?.retrySameRequest && renderAttempt.current !== null;
  const renderIsOldHead = shown !== null && shown.view.revisionId !== project.headRevisionId;

  return <section id="dev-project-outputs" aria-labelledby="dev-outputs-title" data-outputs="DEV_ONLY">
    <h3 id="dev-outputs-title">Render and review · DEV_ONLY</h3>
    <p>Local development rendering of the exact project revision and a DEV_ONLY review case. Neither establishes human approval. A render is exported only by the explicit export control below it, and is delivered only with a destination receipt.</p>

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
        <DevVerifiedContent key={`content:${shown.view.artifactVersionId}`} reader={contentReader} artifact={shown.view} kind={shown.view.format} locked={locked} />
        <DevExportControls key={shown.view.artifactVersionId} outputs={outputs} view={shown.view} locked={locked} newRequestId={newRequestId} />
      </article>}
      <form id="render-known-form" onSubmit={(event) => { event.preventDefault(); void reopenKnownRender(); }}>
        <label htmlFor="known-render-id">Known render ID</label>
        <input id="known-render-id" value={knownRenderId} onChange={(event) => setKnownRenderId(event.currentTarget.value)} disabled={busy} autoComplete="off" spellCheck={false} />
        <button type="submit" disabled={busy || !OPAQUE_ID.test(knownRenderId.trim())}>Reopen known render</button>
      </form>
    </section>

    <DevRightsSection key={shown ? `rights:${shown.view.artifactId}@${shown.view.artifactVersionId}` : "rights:none"} outputs={outputs} locked={locked}
      artifact={shown ? { artifactId: shown.view.artifactId, artifactVersionId: shown.view.artifactVersionId } : null} />

    <DevReviewSection outputs={outputs} locked={locked} newRequestId={newRequestId} projectId={project.projectId} headKey={project.headRevisionId}
      onBusyChange={setReviewBusy} subjectChoices={[
        { id: "revision", subject: { kind: "PROJECT_REVISION", projectId: project.projectId, revisionId: revision.revisionId },
          wantedReference: `project_revision:${project.projectId}@${revision.revisionId}`,
          label: <>Project revision <code>{revision.revisionId}</code></> },
        { id: "render", subject: shown ? { kind: "ARTIFACT_VERSION", artifactId: shown.view.artifactId, artifactVersionId: shown.view.artifactVersionId } : null,
          wantedReference: null, disabled: !shown,
          label: shown ? <>Render artifact version <code>{shown.view.artifactVersionId}</code></> : "Render artifact version (render first)" },
      ]} />
  </section>;
}
