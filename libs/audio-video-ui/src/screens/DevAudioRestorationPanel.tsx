import React from "react";
import {
  describeAudioFailure, describeAudioVerdict, parseAudioComparisonView, parseAudioHostStatus, parseAudioRestorationView,
  type AudioComparisonReport, type AudioFailure, type AudioHostStatus, type AudioRestorationView, type AudioSideMetrics,
  type DevAudioOperations, type DevAudioRestorationPort,
} from "./devAudioRestoration";
import { describeContentFailure, readVerifiedContent, type DevArtifactContentReader, type DigestFunction, type RegisteredArtifact } from "./devArtifactContent";

export interface DevAudioRestorationPanelProps {
  readonly audio: DevAudioRestorationPort;
  readonly locked?: boolean;
  /** Injectable for deterministic tests; must return a fresh opaque id per call. */
  readonly newRequestId?: () => string;
  /** Test seam for the content digest; defaults to the browser's SHA-256. */
  readonly digest?: DigestFunction;
}

type StatusState = { readonly phase: "loading" } | { readonly phase: "failed"; readonly failure: AudioFailure }
  | { readonly phase: "loaded"; readonly status: AudioHostStatus };
type Run = { readonly restoration: AudioRestorationView; readonly report: AudioComparisonReport | null; readonly compareFailure: AudioFailure | null;
  readonly source: { readonly artifactId: string; readonly artifactVersionId: string } };
type Working = "idle" | "restoring" | "measuring";

let counter = 0;
const defaultRequestId = (): string => {
  const random = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${(counter++).toString(36)}`;
  return `audio-${random}`;
};

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EXACT_VERSION = /^sha256:[0-9a-f]{64}$/u;
const TONE_HEADING: Readonly<Record<AudioFailure["tone"], string>> = {
  denied: "Denied", unknown: "Outcome unknown", unavailable: "Unavailable", invalid: "Not registered", stale: "Stale version",
};

const fmt = (value: number | null, digits = 2): string => value === null ? "not measured" : value.toFixed(digits);
const signed = (value: number | null, digits = 2): string => value === null ? "not measured" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
const wavArtifact = (artifactId: string, artifactVersionId: string): RegisteredArtifact =>
  ({ artifactId, artifactVersionId, contentType: "audio/wav", sizeBytes: null, sha256: artifactVersionId.slice("sha256:".length) });

/**
 * DEV_ONLY audio restoration with a measured A/B comparison. The operations are the host's typed, bounded set
 * (declip, 50/60 Hz dehum, FFT denoise, loudness normalization OFF by default). After restoring, the page asks the host
 * to MEASURE source against restored (and against a clean reference when one is named): every number and the verdict
 * are the host's. Both clips are played only after their SHA-256 equals the registered one, through one player that
 * switches between them at the same playback position.
 */
export function DevAudioRestorationPanel({ audio, locked = false, newRequestId = defaultRequestId, digest }: DevAudioRestorationPanelProps): React.ReactElement {
  const [status, setStatus] = React.useState<StatusState>({ phase: "loading" });
  const [sourceId, setSourceId] = React.useState("");
  const [sourceVersion, setSourceVersion] = React.useState("");
  const [referenceId, setReferenceId] = React.useState("");
  const [referenceVersion, setReferenceVersion] = React.useState("");
  const [referenceText, setReferenceText] = React.useState("");
  const [diffTranscript, setDiffTranscript] = React.useState(false);
  const [declipOn, setDeclipOn] = React.useState(true);
  const [threshold, setThreshold] = React.useState("10");
  const [dehum, setDehum] = React.useState<"off" | "50" | "60">("off");
  const [denoiseOn, setDenoiseOn] = React.useState(true);
  const [reductionDb, setReductionDb] = React.useState("12");
  const [noiseFloorDb, setNoiseFloorDb] = React.useState("-50");
  const [trackNoise, setTrackNoise] = React.useState(true);
  const [normalizeOn, setNormalizeOn] = React.useState(false);
  const [targetLufs, setTargetLufs] = React.useState("-16");
  const [working, setWorking] = React.useState<Working>("idle");
  const [failure, setFailure] = React.useState<AudioFailure | null>(null);
  const [formErrors, setFormErrors] = React.useState<readonly string[]>([]);
  const [run, setRun] = React.useState<Run | null>(null);
  const restoreAttempt = React.useRef<{ fingerprint: string; requestId: string } | null>(null);
  const compareAttempt = React.useRef<{ fingerprint: string; requestId: string } | null>(null);
  const resultHeading = React.useRef<HTMLHeadingElement | null>(null);
  const sourceField = React.useRef<HTMLInputElement | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const loadStatus = React.useCallback(async (): Promise<void> => {
    setStatus({ phase: "loading" });
    try {
      const parsed = parseAudioHostStatus(await audio.getStatus());
      if (alive.current) setStatus({ phase: "loaded", status: parsed });
    } catch (error) {
      if (alive.current) setStatus({ phase: "failed", failure: describeAudioFailure(error) });
    }
  }, [audio]);
  React.useEffect(() => { void loadStatus(); }, [loadStatus]);
  React.useEffect(() => { if (run) resultHeading.current?.focus(); }, [run]);

  const hostStatus = status.phase === "loaded" ? status.status : null;
  const usable = !!hostStatus && hostStatus.engineReady;
  const busy = working !== "idle";
  const disabled = locked || busy || !usable;

  const buildOperations = (errors: string[]): DevAudioOperations => {
    const ops: { -readonly [K in keyof DevAudioOperations]: DevAudioOperations[K] } = {};
    const number = (raw: string, label: string, min: number, max: number, whole = false): number => {
      const value = Number(raw);
      if (!raw.trim() || !Number.isFinite(value) || value < min || value > max || (whole && !Number.isInteger(value))) {
        errors.push(`${label} must be ${whole ? "a whole number" : "a number"} from ${min} to ${max}.`);
        return min;
      }
      return value;
    };
    if (declipOn) ops.declip = { threshold: number(threshold, "Declip sensitivity threshold", 1, 100, true) };
    if (dehum !== "off") ops.dehum = { frequencyHz: dehum === "50" ? 50 : 60 };
    if (denoiseOn) ops.denoise = { reductionDb: number(reductionDb, "Noise reduction", 1, 40), noiseFloorDb: number(noiseFloorDb, "Noise floor", -80, -20), trackNoise };
    if (normalizeOn) ops.normalize = { targetLufs: number(targetLufs, "Loudness target", -30, -10) };
    if (!ops.declip && !ops.dehum && !ops.denoise && !ops.normalize) errors.push("Choose at least one restoration operation.");
    return ops;
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (disabled) return;
    const errors: string[] = [];
    const source = sourceId.trim();
    const version = sourceVersion.trim();
    if (!OPAQUE_ID.test(source)) errors.push("Enter the source artifact id.");
    if (!EXACT_VERSION.test(version)) errors.push("Enter the exact source version as sha256: followed by 64 hexadecimal characters.");
    const refId = referenceId.trim();
    const refVersion = referenceVersion.trim();
    const hasReference = refId !== "" || refVersion !== "";
    if (hasReference && (!OPAQUE_ID.test(refId) || !EXACT_VERSION.test(refVersion))) errors.push("A clean reference needs both its artifact id and its exact sha256: version.");
    if (diffTranscript && !hasReference && !referenceText.trim()) errors.push("A transcript diff needs a clean reference version or the known clean text.");
    if (referenceText.length > 2000) errors.push("The known clean text is limited to 2000 characters.");
    const operations = buildOperations(errors);
    setFormErrors(errors);
    if (errors.length > 0) { sourceField.current?.focus(); return; }

    const restoreFingerprint = JSON.stringify([source, version, operations]);
    if (!restoreAttempt.current || restoreAttempt.current.fingerprint !== restoreFingerprint) restoreAttempt.current = { fingerprint: restoreFingerprint, requestId: newRequestId() };
    setWorking("restoring"); setFailure(null); setRun(null);
    let restoration: AudioRestorationView;
    try {
      const response = await audio.restore({ requestId: restoreAttempt.current.requestId, artifactId: source, artifactVersionId: version, operations });
      restoration = parseAudioRestorationView(response);
    } catch (error) {
      if (alive.current) { setFailure(describeAudioFailure(error)); setWorking("idle"); }
      return;
    }
    if (!alive.current) return;
    setWorking("measuring");
    const transcript = diffTranscript ? { language: "en", ...(referenceText.trim() ? { referenceText: referenceText.trim() } : {}) } : undefined;
    const compareFingerprint = JSON.stringify([source, version, restoration.artifact.artifactVersionId, refId, refVersion, transcript ?? null]);
    if (!compareAttempt.current || compareAttempt.current.fingerprint !== compareFingerprint) compareAttempt.current = { fingerprint: compareFingerprint, requestId: newRequestId() };
    try {
      const response = await audio.compare({
        requestId: compareAttempt.current.requestId,
        source: { artifactId: source, artifactVersionId: version },
        restored: { artifactId: restoration.artifact.artifactId, artifactVersionId: restoration.artifact.artifactVersionId },
        ...(hasReference ? { reference: { artifactId: refId, artifactVersionId: refVersion } } : {}),
        ...(transcript ? { transcript } : {}),
      });
      const report = parseAudioComparisonView(response);
      if (alive.current) setRun({ restoration, report, compareFailure: null, source: { artifactId: source, artifactVersionId: version } });
    } catch (error) {
      if (alive.current) setRun({ restoration, report: null, compareFailure: describeAudioFailure(error), source: { artifactId: source, artifactVersionId: version } });
    } finally {
      if (alive.current) setWorking("idle");
    }
  };

  const check = (id: string, label: string, checked: boolean, onChange: (next: boolean) => void): React.ReactElement =>
    <label htmlFor={id} className="audio-check"><input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} /> {label}</label>;

  return <section aria-labelledby="audio-restoration-title" className="audio-restoration" data-audio-state={status.phase}>
    <h2 id="audio-restoration-title">Audio restoration A/B</h2>
    <p className="audio-scope">DEV_ONLY local denoise, declip and dehum with FFmpeg. The source is never modified: a restoration is a new version. Every figure is measured by the host; no perceptual-quality, rights or approval claim.</p>

    <p role={status.phase === "failed" ? "alert" : "status"} aria-live="polite" aria-atomic="true" aria-busy={status.phase === "loading"} data-audio-engine-status>
      {status.phase === "loading" && "Reading the audio engine status from the host…"}
      {status.phase === "failed" && `${status.failure.code}: ${status.failure.text}`}
      {hostStatus && hostStatus.engineReady && `Engine ${hostStatus.engineVersion ?? "unknown"} is ready${hostStatus.transcriptReady ? "; the Whisper transcript diff is available" : "; the Whisper transcript diff is not available on this host"}.`}
      {hostStatus && !hostStatus.engineReady && "The audio engine is not available on this host. Nothing can be restored."}
    </p>
    {status.phase === "failed" && <p><button type="button" onClick={() => void loadStatus()}>Retry reading status</button></p>}

    <form onSubmit={(event) => void submit(event)} aria-describedby="audio-restoration-help" noValidate>
      <p id="audio-restoration-help">Name the exact WAV version to restore (from the artifact intake page) and, optionally, the clean reference it should be measured against. Processing rights for each exact version must already be attested.</p>
      <fieldset disabled={disabled}>
        <legend>Source</legend>
        <div className="audio-field"><label htmlFor="audio-source-id">Source artifact id</label>
          <input id="audio-source-id" ref={sourceField} type="text" autoComplete="off" spellCheck={false} value={sourceId} onChange={(event) => { setSourceId(event.currentTarget.value); setFormErrors([]); }} /></div>
        <div className="audio-field"><label htmlFor="audio-source-version">Source exact version</label>
          <input id="audio-source-version" type="text" autoComplete="off" spellCheck={false} placeholder="sha256:…" value={sourceVersion} onChange={(event) => { setSourceVersion(event.currentTarget.value); setFormErrors([]); }} /></div>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Clean reference (optional)</legend>
        <div className="audio-field"><label htmlFor="audio-reference-id">Reference artifact id</label>
          <input id="audio-reference-id" type="text" autoComplete="off" spellCheck={false} value={referenceId} onChange={(event) => { setReferenceId(event.currentTarget.value); setFormErrors([]); }} /></div>
        <div className="audio-field"><label htmlFor="audio-reference-version">Reference exact version</label>
          <input id="audio-reference-version" type="text" autoComplete="off" spellCheck={false} placeholder="sha256:…" value={referenceVersion} onChange={(event) => { setReferenceVersion(event.currentTarget.value); setFormErrors([]); }} /></div>
        {check("audio-transcript", `Also diff the Whisper transcript${hostStatus && !hostStatus.transcriptReady ? " (not available on this host)" : ""}`, diffTranscript, (next) => { setDiffTranscript(next); setFormErrors([]); })}
        <div className="audio-field"><label htmlFor="audio-reference-text">Known clean text (optional, replaces the reference transcript)</label>
          <textarea id="audio-reference-text" rows={2} maxLength={2000} value={referenceText} onChange={(event) => setReferenceText(event.currentTarget.value)} /></div>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Restoration operations</legend>
        <div className="audio-op">{check("audio-declip", "Declip", declipOn, setDeclipOn)}
          <label htmlFor="audio-declip-threshold">Declip threshold (1 to 100)</label>
          <input id="audio-declip-threshold" type="number" inputMode="numeric" min={1} max={100} step={1} value={threshold} disabled={disabled || !declipOn} onChange={(event) => { setThreshold(event.currentTarget.value); setFormErrors([]); }} /></div>
        <div className="audio-op"><label htmlFor="audio-dehum">Remove mains hum</label>
          <select id="audio-dehum" value={dehum} disabled={disabled} onChange={(event) => setDehum(event.currentTarget.value as "off" | "50" | "60")}>
            <option value="off">Off</option><option value="50">50 Hz (with harmonics)</option><option value="60">60 Hz (with harmonics)</option></select></div>
        <div className="audio-op">{check("audio-denoise", "Denoise", denoiseOn, setDenoiseOn)}
          <label htmlFor="audio-reduction">Noise reduction in dB (1 to 40)</label>
          <input id="audio-reduction" type="number" inputMode="decimal" min={1} max={40} step={1} value={reductionDb} disabled={disabled || !denoiseOn} onChange={(event) => { setReductionDb(event.currentTarget.value); setFormErrors([]); }} />
          <label htmlFor="audio-noise-floor">Noise floor in dB (-80 to -20)</label>
          <input id="audio-noise-floor" type="number" inputMode="decimal" min={-80} max={-20} step={1} value={noiseFloorDb} disabled={disabled || !denoiseOn} onChange={(event) => { setNoiseFloorDb(event.currentTarget.value); setFormErrors([]); }} />
          <label htmlFor="audio-track" className="audio-check"><input id="audio-track" type="checkbox" checked={trackNoise} disabled={disabled || !denoiseOn} onChange={(event) => setTrackNoise(event.currentTarget.checked)} /> Track the noise floor</label></div>
        <div className="audio-op">{check("audio-normalize", "Normalize loudness (off by default; changes the level)", normalizeOn, setNormalizeOn)}
          <label htmlFor="audio-lufs">Target loudness in LUFS (-30 to -10)</label>
          <input id="audio-lufs" type="number" inputMode="decimal" min={-30} max={-10} step={1} value={targetLufs} disabled={disabled || !normalizeOn} onChange={(event) => { setTargetLufs(event.currentTarget.value); setFormErrors([]); }} /></div>
      </fieldset>
      {formErrors.length > 0 && <ul role="alert" className="audio-errors">{formErrors.map((message) => <li key={message}>{message}</li>)}</ul>}
      <p><button type="submit" disabled={disabled} aria-busy={busy}>{working === "restoring" ? "Restoring…" : working === "measuring" ? "Measuring…" : "Restore and measure"}</button></p>
    </form>

    <p role="status" aria-live="polite" aria-atomic="true" data-audio-progress>
      {working === "restoring" && "Restoring with the local engine. The result is shown only after the host registers it."}
      {working === "measuring" && "Restoration registered. Measuring source against restored…"}
      {working === "idle" && (run ? "Restoration registered." : "Nothing restored yet.")}
    </p>

    {failure && <div role="alert" className="audio-failure" data-failure-code={failure.code} data-failure-tone={failure.tone}>
      <h3>{TONE_HEADING[failure.tone]}</h3><p><code>{failure.code}</code> {failure.text}</p></div>}

    {run && <section aria-labelledby="audio-result-title" className="audio-result" data-audio-result>
      <h3 id="audio-result-title" ref={resultHeading} tabIndex={-1}>Restored version</h3>
      <dl>
        <dt>Restored artifact</dt><dd><code data-restored-id>{run.restoration.artifact.artifactId}</code></dd>
        <dt>Restored version</dt><dd><code data-restored-version>{run.restoration.artifact.artifactVersionId}</code></dd>
        <dt>Derived from</dt><dd><code>{run.restoration.sourceVersionId}</code> (unchanged)</dd>
        <dt>Engine</dt><dd>{run.restoration.engineVersion ?? "not reported"}</dd>
        <dt>Filter graph</dt><dd><code data-filter-graph>{run.restoration.filterGraph}</code></dd>
        <dt>Outcome</dt><dd>{run.restoration.replayed ? "Replayed: the same request identifier returned the existing restoration." : "Created as a new version."}</dd>
      </dl>
      {run.compareFailure && <div role="alert" className="audio-failure" data-failure-code={run.compareFailure.code} data-failure-tone={run.compareFailure.tone}>
        <h4>Measurement not made</h4><p><code>{run.compareFailure.code}</code> {run.compareFailure.text} The restoration above is registered; press Restore and measure again to retry the measurement.</p></div>}
      {run.report && <MeasuredComparison report={run.report} />}
      <AudioAbPlayer key={run.restoration.artifact.artifactVersionId} reader={audio.readArtifactContent ? { readArtifactContent: audio.readArtifactContent } : undefined}
        source={wavArtifact(run.source.artifactId, run.source.artifactVersionId)} restored={run.restoration.artifact} locked={locked} digest={digest} />
    </section>}
  </section>;
}

function row(metric: string, label: string, unit: string, source: string, restored: string, change: string, reference?: string): React.ReactElement {
  return <tr data-metric={metric}>
    <th scope="row">{label}{unit ? ` (${unit})` : ""}</th><td data-cell="source">{source}</td><td data-cell="restored">{restored}</td><td data-cell="change">{change}</td>
    {reference !== undefined && <td data-cell="reference">{reference}</td>}
  </tr>;
}

function MeasuredComparison({ report }: { readonly report: AudioComparisonReport }): React.ReactElement {
  const ref: AudioSideMetrics | null = report.reference;
  const withRef = ref !== null;
  const pair = (value: number | null, digits = 2): string => fmt(value, digits);
  return <section aria-labelledby="audio-measure-title" data-audio-measurement data-verdict={report.verdict.overall}>
    <h4 id="audio-measure-title">Measured comparison</h4>
    <p role="status" aria-live="polite" data-verdict-text>{describeAudioVerdict(report)}</p>
    <table>
      <caption>Source against restored{withRef ? ", measured against the clean reference" : " (no clean reference: descriptive only)"}</caption>
      <thead><tr><th scope="col">Measure</th><th scope="col">Source (A)</th><th scope="col">Restored (B)</th><th scope="col">Change</th>{withRef && <th scope="col">Clean reference</th>}</tr></thead>
      <tbody>
        {row("snr", "SNR against the reference", "dB, higher is closer", pair(report.source.snrDb), pair(report.restored.snrDb), `${signed(report.delta.snrDb)} (${report.verdict.snr.toLowerCase().replace(/_/gu, " ")})`, withRef ? "is the reference" : undefined)}
        {row("segmental-snr", "Segmental SNR against the reference", "dB", pair(report.source.segmentalSnrDb), pair(report.restored.segmentalSnrDb), `${signed(report.delta.segmentalSnrDb)} (${report.verdict.segmentalSnr.toLowerCase().replace(/_/gu, " ")})`, withRef ? "is the reference" : undefined)}
        {row("clipped", "Clipped samples", "count", String(report.source.clippedSamples), String(report.restored.clippedSamples), `${report.delta.clippedSamples === null ? "not measured" : (report.delta.clippedSamples > 0 ? "+" : "") + report.delta.clippedSamples} (${report.verdict.clipping.toLowerCase()})`, withRef ? String(ref.clippedSamples) : undefined)}
        {row("noise-floor", "Noise-floor level", "dBFS, lower is quieter", pair(report.source.noiseFloorDbfs), pair(report.restored.noiseFloorDbfs), `${signed(report.delta.noiseFloorDbfs)} (${report.verdict.noiseFloorLevel.toLowerCase()})`, withRef ? pair(ref.noiseFloorDbfs) : undefined)}
        {row("flatness", "Noise-floor spectral flatness", "1 is white noise", pair(report.source.noiseFloorFlatness, 3), pair(report.restored.noiseFloorFlatness, 3), signed(report.delta.noiseFloorFlatness, 3), withRef ? pair(ref.noiseFloorFlatness, 3) : undefined)}
      </tbody>
    </table>
    <p data-transcript-status={report.transcript.status}>
      {report.transcript.status === "MEASURED"
        ? `Whisper transcript against the clean text: word error rate ${fmt(report.transcript.sourceWordErrorRate, 3)} for the source and ${fmt(report.transcript.restoredWordErrorRate, 3)} for the restored version (${(report.transcript.intelligibility ?? "unchanged").toLowerCase()}). Intelligibility ${report.transcript.intelligibility === "REGRESSED" ? "REGRESSED" : "did not regress"}.`
        : report.transcript.status === "NOT_REQUESTED" ? "No transcript diff was requested." : `Transcript diff status: ${report.transcript.status}.`}
    </p>
    {report.transcript.status === "MEASURED" && <details><summary>Transcripts</summary>
      <dl><dt>Clean</dt><dd>{report.transcript.cleanText}</dd><dt>Source</dt><dd>{report.transcript.sourceText}</dd><dt>Restored</dt><dd>{report.transcript.restoredText}</dd></dl></details>}
  </section>;
}

type ClipState = { readonly phase: "idle" | "loading" | "ready" | "failed"; readonly message: string };

/** One audio element that switches between the verified source and restored clips at the same position. */
function AudioAbPlayer({ reader, source, restored, locked, digest }: {
  readonly reader: DevArtifactContentReader | undefined; readonly source: RegisteredArtifact; readonly restored: RegisteredArtifact;
  readonly locked: boolean; readonly digest: DigestFunction | undefined;
}): React.ReactElement {
  const [clips, setClips] = React.useState<ClipState>({ phase: "idle", message: "The clips are not loaded." });
  const [urls, setUrls] = React.useState<{ readonly a: string; readonly b: string } | null>(null);
  const [which, setWhich] = React.useState<"A" | "B">("A");
  const element = React.useRef<HTMLAudioElement | null>(null);
  const pendingSeek = React.useRef<{ time: number; playing: boolean } | null>(null);
  const created = React.useRef<string[]>([]);
  React.useEffect(() => () => { for (const url of created.current) URL.revokeObjectURL(url); created.current = []; }, []);

  const load = async (): Promise<void> => {
    if (!reader || clips.phase === "loading") return;
    setClips({ phase: "loading", message: "Reading both versions and verifying their SHA-256…" });
    try {
      const options = digest ? { digest } : {};
      const [a, b] = await Promise.all([readVerifiedContent(reader, source, options), readVerifiedContent(reader, restored, options)]);
      const make = (content: { bytes: Uint8Array; contentType: string }): string => {
        const url = URL.createObjectURL(new Blob([content.bytes as BlobPart], { type: content.contentType }));
        created.current.push(url);
        return url;
      };
      setUrls({ a: make(a), b: make(b) });
      setClips({ phase: "ready", message: `Both clips verified against their registered versions. A (source) SHA-256 ${a.sha256}; B (restored) SHA-256 ${b.sha256}.` });
    } catch (error) {
      const shown = describeContentFailure(error);
      setClips({ phase: "failed", message: `${shown.code}: ${shown.text}` });
    }
  };

  const choose = (next: "A" | "B"): void => {
    if (next === which) return;
    const audioElement = element.current;
    pendingSeek.current = audioElement ? { time: audioElement.currentTime, playing: !audioElement.paused } : null;
    setWhich(next);
  };
  const onLoaded = (): void => {
    const audioElement = element.current;
    const seek = pendingSeek.current;
    if (!audioElement || !seek) return;
    pendingSeek.current = null;
    audioElement.currentTime = Math.min(seek.time, Number.isFinite(audioElement.duration) ? audioElement.duration : seek.time);
    if (seek.playing) void audioElement.play().catch(() => undefined);
  };

  const label = which === "A" ? "Source (A)" : "Restored (B)";
  return <section aria-labelledby="audio-ab-title" data-audio-ab data-ab-state={clips.phase}>
    <h4 id="audio-ab-title">Listen: source against restored</h4>
    {!reader && <p role="note">This host exposes no DEV_ONLY content route to this page, so the clips cannot be played here.</p>}
    {reader && clips.phase !== "ready" && <p><button type="button" onClick={() => void load()} disabled={locked || clips.phase === "loading"}>Load both clips (verify bytes first)</button></p>}
    {reader && <p role={clips.phase === "failed" ? "alert" : "status"} aria-live="polite" aria-atomic="true" aria-busy={clips.phase === "loading"} data-ab-status>{clips.message}</p>}
    {clips.phase === "ready" && urls && <>
      <fieldset className="audio-ab-choice">
        <legend>Which version do you hear?</legend>
        <label htmlFor="audio-ab-a"><input id="audio-ab-a" type="radio" name="audio-ab" value="A" checked={which === "A"} onChange={() => choose("A")} /> Source (A)</label>
        <label htmlFor="audio-ab-b"><input id="audio-ab-b" type="radio" name="audio-ab" value="B" checked={which === "B"} onChange={() => choose("B")} /> Restored (B)</label>
      </fieldset>
      <p><button type="button" onClick={() => choose(which === "A" ? "B" : "A")} data-ab-toggle>Switch to {which === "A" ? "restored (B)" : "source (A)"}</button></p>
      <audio ref={element} src={which === "A" ? urls.a : urls.b} controls preload="metadata" onLoadedMetadata={onLoaded}
        aria-label={`A/B player, currently the ${label} version`} data-ab-current={which} />
      <p role="status" aria-live="polite" aria-atomic="true" data-ab-announce>Now hearing the {label} version at the same position.</p>
    </>}
  </section>;
}
