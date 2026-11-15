import React from "react";
import { DevQualityHostError, type DevQualityPort } from "./dev-quality-optimization-client";

type Json = Record<string, unknown>;
type Phase = "idle" | "running" | "failed";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const asRecord = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : {});
const asList = (value: unknown): Json[] => (Array.isArray(value) ? value.map(asRecord) : []);
const text = (value: unknown): string => (value === null || value === undefined ? "—" : String(value));
const newRequestId = (): string => `opt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * The DEV_ONLY bounded quality optimization panel. It shows exactly what the host measured: every attempt (including the
 * ones that failed the target), the chosen attempt or the typed abstention, the head of the lineage and an undo that
 * restores the previous version. Nothing is computed in the browser and no verdict is colour-only.
 */
export function DevQualityPanel({ quality }: { readonly quality: DevQualityPort }): React.JSX.Element {
  const [requestId, setRequestId] = React.useState(newRequestId);
  const [lineageId, setLineageId] = React.useState("");
  const [artifactId, setArtifactId] = React.useState("");
  const [versionId, setVersionId] = React.useState("");
  const [goal, setGoal] = React.useState("MIN_BYTES_AT_QUALITY");
  const [metric, setMetric] = React.useState("ssim");
  const [threshold, setThreshold] = React.useState("0.90");
  const [crfMin, setCrfMin] = React.useState("16");
  const [crfMax, setCrfMax] = React.useState("40");
  const [maxAttempts, setMaxAttempts] = React.useState("6");
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [announce, setAnnounce] = React.useState("");
  const [failure, setFailure] = React.useState<{ code: string; message: string } | null>(null);
  const [result, setResult] = React.useState<Json | null>(null);
  const [lineage, setLineage] = React.useState<Json | null>(null);
  const [undoNote, setUndoNote] = React.useState("");
  const [bounds, setBounds] = React.useState<Json | null>(null);
  const resultTitle = React.useRef<HTMLHeadingElement>(null);
  const lineageTitle = React.useRef<HTMLHeadingElement>(null);

  const focusResult = React.useRef(false);
  const focusLineage = React.useRef(false);
  // Focus moves to a heading only after React has rendered it (a microtask would run before the commit).
  React.useEffect(() => {
    if (focusResult.current && result) { focusResult.current = false; resultTitle.current?.focus(); }
  }, [result]);
  React.useEffect(() => {
    if (focusLineage.current && lineage) { focusLineage.current = false; lineageTitle.current?.focus(); }
  }, [lineage]);

  React.useEffect(() => {
    let live = true;
    quality.status().then((response) => { if (live) setBounds(asRecord(asRecord(response.body).bounds)); }).catch(() => undefined);
    return () => { live = false; };
  }, [quality]);

  const fail = (error: unknown): void => {
    const known = error instanceof DevQualityHostError;
    setFailure({
      code: known ? error.code : "UNEXPECTED",
      message: known ? error.message : "The request failed unexpectedly.",
    });
    setPhase("failed");
    setAnnounce(known ? `Failed: ${error.code}. ${error.message}` : "Failed.");
  };

  const run = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setFailure(null);
    setResult(null);
    if (!OPAQUE_ID.test(requestId) || !OPAQUE_ID.test(lineageId)) {
      fail(new DevQualityHostError("INVALID_INPUT", 0, "Request id and lineage id are 1-100 letters, digits, dot, colon, dash or underscore."));
      return;
    }
    const numeric = (value: string): number => Number(value);
    const target = goal === "MIN_BYTES_AT_QUALITY"
      ? { type: goal, metric, minQuality: numeric(threshold) }
      : { type: goal, metric, maxBytes: numeric(threshold) };
    setPhase("running");
    setAnnounce("Running the bounded search. Each attempt is a real encode followed by a measurement.");
    try {
      const response = await quality.optimize({
        requestId, lineageId, artifactId, artifactVersionId: versionId, target,
        search: { crfMin: numeric(crfMin), crfMax: numeric(crfMax), maxAttempts: numeric(maxAttempts) },
      });
      const body = asRecord(response.body);
      setResult(body);
      const lin = asRecord(body.lineage);
      setLineage(Object.keys(lin).length > 0 ? lin : null);
      setPhase("idle");
      setUndoNote("");
      setAnnounce(body.outcome === "SELECTED"
        ? `Selected attempt ${text(asRecord(body.report).chosenAttempt)} of ${asList(asRecord(body.report).attempts).length}.`
        : `No attempt met the target within the bounds. Nothing was chosen and the head did not move.`);
      setRequestId(newRequestId());
      focusResult.current = true;
    } catch (error) {
      fail(error);
    }
  };

  const cancel = async (): Promise<void> => {
    try {
      await quality.cancel(requestId);
      setAnnounce("Cancellation requested; the running encode is being stopped.");
    } catch (error) {
      fail(error);
    }
  };

  const openLineage = async (): Promise<void> => {
    setFailure(null);
    try {
      const response = await quality.getLineage(lineageId);
      setLineage(asRecord(response.body));
      setAnnounce("Lineage loaded.");
      focusLineage.current = true;
    } catch (error) {
      fail(error);
    }
  };

  const undo = async (): Promise<void> => {
    setFailure(null);
    const head = asRecord(lineage?.head);
    try {
      const response = await quality.undo(lineageId, {
        requestId: `undo-${newRequestId()}`,
        expectedHeadArtifactVersionId: head.artifactVersionId,
      });
      const body = asRecord(response.body);
      const reread = await quality.getLineage(lineageId);
      setLineage(asRecord(reread.body));
      setUndoNote(`Undone: the head is again ${text(asRecord(body.head).artifactVersionId)}.`);
      setAnnounce(`Undone. The head is again version ${text(asRecord(body.head).artifactVersionId)}.`);
      focusLineage.current = true;
    } catch (error) {
      fail(error);
    }
  };

  const report = asRecord(result?.report);
  const attempts = asList(report.attempts);
  const chosenIndex = typeof report.chosenAttempt === "number" ? report.chosenAttempt : null;
  const chosen = asRecord(result?.chosen);
  const head = asRecord(lineage?.head);
  const events = asList(lineage?.events);
  const minQualityGoal = goal === "MIN_BYTES_AT_QUALITY";
  const busy = phase === "running";

  return (
    <section className="quality" aria-labelledby="quality-title">
      <h2 id="quality-title">Bounded quality optimization</h2>
      <p aria-live="polite" role="status" data-quality-status>{announce}</p>
      {bounds ? <p className="quality-hint" data-quality-bounds>Host bounds: at most {text(bounds.maxAttempts)} attempts, CRF {text(bounds.crfFloor)} to {text(bounds.crfCeiling)}, {text(bounds.maxFrames)} frames.</p> : null}
      <form onSubmit={(event) => { void run(event); }} aria-describedby="quality-help">
        <p id="quality-help" className="quality-hint">Name one stored video version you own and a target. The host searches a CRF range with real encodes and measures each result against the source.</p>
        <fieldset>
          <legend>Source</legend>
          <div className="quality-field"><label htmlFor="quality-lineage">Lineage id</label><input id="quality-lineage" value={lineageId} onChange={(e) => setLineageId(e.target.value)} required autoComplete="off" /></div>
          <div className="quality-field"><label htmlFor="quality-artifact">Video artifact id</label><input id="quality-artifact" value={artifactId} onChange={(e) => setArtifactId(e.target.value)} required autoComplete="off" /></div>
          <div className="quality-field"><label htmlFor="quality-version">Video artifact version id</label><input id="quality-version" value={versionId} onChange={(e) => setVersionId(e.target.value)} required autoComplete="off" /></div>
        </fieldset>
        <fieldset>
          <legend>Target</legend>
          <div className="quality-field"><label htmlFor="quality-goal">Goal</label>
            <select id="quality-goal" value={goal} onChange={(e) => { setGoal(e.target.value); setThreshold(e.target.value === "MIN_BYTES_AT_QUALITY" ? (metric === "ssim" ? "0.90" : "35") : "200000"); }}>
              <option value="MIN_BYTES_AT_QUALITY">Smallest file at a minimum quality</option>
              <option value="MAX_QUALITY_UNDER_BYTES">Best quality within a byte budget</option>
            </select></div>
          <div className="quality-field"><label htmlFor="quality-metric">Quality metric</label>
            <select id="quality-metric" value={metric} onChange={(e) => { setMetric(e.target.value); if (minQualityGoal) setThreshold(e.target.value === "ssim" ? "0.90" : "35"); }}>
              <option value="ssim">Luma SSIM (0.5 to 0.9999)</option>
              <option value="psnr">Luma PSNR in dB (20 to 80)</option>
            </select></div>
          <div className="quality-field"><label htmlFor="quality-threshold">{minQualityGoal ? "Minimum quality" : "Maximum bytes"}</label>
            <input id="quality-threshold" value={threshold} onChange={(e) => setThreshold(e.target.value)} required inputMode="decimal" autoComplete="off" /></div>
        </fieldset>
        <fieldset>
          <legend>Search bounds</legend>
          <div className="quality-field"><label htmlFor="quality-crf-min">Lowest CRF to try</label><input id="quality-crf-min" value={crfMin} onChange={(e) => setCrfMin(e.target.value)} required inputMode="numeric" autoComplete="off" /></div>
          <div className="quality-field"><label htmlFor="quality-crf-max">Highest CRF to try</label><input id="quality-crf-max" value={crfMax} onChange={(e) => setCrfMax(e.target.value)} required inputMode="numeric" autoComplete="off" /></div>
          <div className="quality-field"><label htmlFor="quality-attempts">Maximum attempts</label><input id="quality-attempts" value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} required inputMode="numeric" autoComplete="off" /></div>
        </fieldset>
        <div>
          <button type="submit" disabled={busy}>Run search</button>{" "}
          <button type="button" onClick={() => { void cancel(); }} disabled={!busy}>Cancel search</button>{" "}
          <button type="button" onClick={() => { void openLineage(); }} disabled={busy || lineageId.length === 0}>Open lineage</button>
        </div>
      </form>
      {failure ? <div className="quality-failure" role="alert" data-quality-failure><p><strong>{failure.code}</strong></p><p>{failure.message}</p></div> : null}
      {result ? (
        <div className="quality-result" data-quality-result data-outcome={text(result.outcome)}>
          <h3 id="quality-result-title" tabIndex={-1} ref={resultTitle}>{result.outcome === "SELECTED" ? `Selected attempt ${text(chosenIndex)}` : "Abstained: no attempt met the target"}</h3>
          <p data-quality-summary>{result.outcome === "SELECTED"
            ? `The chosen attempt is a new immutable version; the source is untouched.`
            : `Reason ${text(report.abstainReason)}. Nothing was chosen, no version was created and the head did not move.`}
            {" "}Search stopped: {text(report.stopReason)}. {result.replayed === true ? "This is a replay of an earlier identical request." : ""}</p>
          <div className="quality-scroll" role="region" aria-label="Attempts table, scrollable" tabIndex={0}>
            <table data-attempt-table>
              <caption>Every attempt, in the order it was run</caption>
              <thead><tr><th scope="col">#</th><th scope="col">CRF</th><th scope="col">Bytes</th><th scope="col">Size vs source</th><th scope="col">SSIM</th><th scope="col">PSNR dB</th><th scope="col">Verdict</th><th scope="col">Chosen</th></tr></thead>
              <tbody>
                {attempts.map((attempt) => (
                  <tr key={text(attempt.attempt)} data-attempt={text(attempt.attempt)} data-crf={text(attempt.crf)} data-feasible={text(attempt.feasible)} data-chosen={String(attempt.attempt === chosenIndex)}>
                    <th scope="row">{text(attempt.attempt)}</th>
                    <td>{text(attempt.crf)}</td><td>{text(attempt.bytes)}</td><td>{text(attempt.sizeRatioVsSource)}</td>
                    <td>{text(attempt.meanSsimY)}</td><td>{text(attempt.globalPsnrY)}</td>
                    <td>{text(attempt.verdict)}</td><td>{attempt.attempt === chosenIndex ? "Chosen" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.outcome === "SELECTED" ? (
            <dl data-quality-chosen>
              <dt>Chosen artifact id</dt><dd data-chosen-artifact>{text(chosen.artifactId)}</dd>
              <dt>Chosen version</dt><dd data-chosen-version>{text(chosen.artifactVersionId)}</dd>
              <dt>Chosen size</dt><dd>{text(chosen.sizeBytes)} bytes</dd>
              <dt>Chosen SHA-256</dt><dd><code>{text(chosen.sha256)}</code></dd>
              <dt>Report artifact</dt><dd data-report-artifact>{text(asRecord(result.reportArtifact).artifactId)}</dd>
            </dl>
          ) : <p>Report artifact <code data-report-artifact>{text(asRecord(result.reportArtifact).artifactId)}</code></p>}
        </div>
      ) : null}
      {lineage ? (
        <div className="quality-lineage" data-quality-lineage>
          <h3 id="quality-lineage-title" tabIndex={-1} ref={lineageTitle}>Lineage head</h3>
          <dl>
            <dt>Head version</dt><dd data-head-version>{text(head.artifactVersionId)}</dd>
            <dt>Head artifact</dt><dd data-head-artifact>{text(head.artifactId)}</dd>
            <dt>Head kind</dt><dd data-head-kind>{text(head.kind)}</dd>
            <dt>Undo available</dt><dd data-undoable>{lineage.undoable === true ? "Yes" : "No"}</dd>
          </dl>
          <p data-undo-note role="status" aria-live="polite">{undoNote}</p>
          <button type="button" onClick={() => { void undo(); }} disabled={lineage.undoable !== true}>Undo to the previous version</button>
          <div className="quality-scroll" role="region" aria-label="Head history, scrollable" tabIndex={0}>
            <table data-event-table>
              <caption>Head history (append-only)</caption>
              <thead><tr><th scope="col">Seq</th><th scope="col">Kind</th><th scope="col">Version</th></tr></thead>
              <tbody>{events.map((event) => (<tr key={text(event.seq)} data-seq={text(event.seq)} data-kind={text(event.kind)}><th scope="row">{text(event.seq)}</th><td>{text(event.kind)}</td><td><code>{text(event.artifactVersionId)}</code></td></tr>))}</tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
