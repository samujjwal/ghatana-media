import React from "react";
import {
  STEM_KINDS, blankPlacement, blankStem, describeMasterFailure, parseMasterStatus, parseMasterView, parseStemView, toMasterRequest,
  toStemRequestSpec, type AuthoredMaster, type AuthoredPlacement, type AuthoredStem, type DevMasterPort, type MasterFailure, type MasterStatus,
  type MasterView, type Problem, type StemView,
} from "./devMaster";
import { describeContentFailure, readVerifiedContent, type RegisteredArtifact } from "./devArtifactContent";

export interface DevMasterPanelProps {
  readonly masters: DevMasterPort;
  readonly locked?: boolean;
  /** Injectable for deterministic tests; must return a fresh opaque id per call. */
  readonly newRequestId?: () => string;
}

type StatusState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly failure: MasterFailure }
  | { readonly phase: "loaded"; readonly status: MasterStatus };

let counter = 0;
const defaultRequestId = (): string => {
  const random = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${(counter++).toString(36)}`;
  return `master-${random}`;
};

const TONE_HEADING: Readonly<Record<MasterFailure["tone"], string>> = {
  invalid: "Request not valid", budget: "Over budget", denied: "Denied", notFound: "Not found", conflict: "Request conflict",
  unknown: "Outcome unknown", unavailable: "Unavailable", abstained: "No master produced",
};

type Playback = { readonly phase: "idle" } | { readonly phase: "loading" }
  | { readonly phase: "verified"; readonly url: string; readonly text: string } | { readonly phase: "failed"; readonly text: string };

/** Loads one master artifact through the verified-content reader: playback starts only after the registered SHA-256 matches. */
function AudioPlayback({ reader, artifact, locked, label, kind }: {
  readonly reader: DevMasterPort["readArtifactContent"]; readonly artifact: RegisteredArtifact; readonly locked: boolean; readonly label: string; readonly kind: string;
}): React.ReactElement {
  const [state, setState] = React.useState<Playback>({ phase: "idle" });
  const urls = React.useRef<string[]>([]);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; for (const url of urls.current) URL.revokeObjectURL(url); urls.current = []; };
  }, []);
  const load = async (): Promise<void> => {
    if (!reader || state.phase === "loading") return;
    setState({ phase: "loading" });
    try {
      const verified = await readVerifiedContent({ readArtifactContent: reader }, artifact);
      const url = URL.createObjectURL(new Blob([verified.bytes as BlobPart], { type: verified.contentType }));
      urls.current.push(url);
      if (alive.current) setState({ phase: "verified", url, text: `Bytes verified against the registered version: SHA-256 ${verified.sha256} (${verified.bytes.byteLength} bytes).` });
    } catch (error) {
      const shown = describeContentFailure(error);
      if (alive.current) setState({ phase: "failed", text: `${shown.code}: ${shown.text}` });
    }
  };
  return <section aria-label={`${kind} playback`} data-playback-state={state.phase} data-playback-kind={kind}>
    {!reader && <p role="note">This host exposes no DEV_ONLY content route to this page, so the audio cannot be played here.</p>}
    {reader && <p><button type="button" onClick={() => void load()} disabled={locked || state.phase === "loading" || state.phase === "verified"}>
      Load the {kind} master (verify bytes first)</button></p>}
    <p role={state.phase === "failed" ? "alert" : "status"} aria-live="polite" aria-atomic="true" aria-busy={state.phase === "loading"} data-playback-status>
      {state.phase === "idle" && `${kind} master not loaded.`}
      {state.phase === "loading" && "Reading the audio and verifying its SHA-256…"}
      {(state.phase === "verified" || state.phase === "failed") && state.text}
    </p>
    {state.phase === "verified" && <audio controls preload="metadata" src={state.url} data-verified-preview={`master-${kind.toLowerCase()}`} aria-label={label} />}
  </section>;
}

const setAt = <T,>(list: readonly T[], index: number, value: T): T[] => list.map((entry, i) => (i === index ? value : entry));
const fmt = (value: number, digits = 2): string => value.toFixed(digits);

/**
 * DEV_ONLY stems, foley, mix and master: build ORIGINAL procedural stems (tones, chords, drum hits, noise foley), place them with
 * gain, pan, sample-exact start and fades, and master the mix to a loudness target under a true-peak ceiling. The result is shown only
 * after the host registers the WAV, the FLAC and the JSON report; audio plays only after its registered SHA-256 matches. Every number is
 * the host's measurement on the output samples. Uploaded stems need a processing rights statement; this page never states rights.
 */
export function DevMasterPanel({ masters, locked = false, newRequestId = defaultRequestId }: DevMasterPanelProps): React.ReactElement {
  const [state, setState] = React.useState<StatusState>({ phase: "loading" });
  const [stem, setStem] = React.useState<AuthoredStem>(blankStem);
  const [built, setBuilt] = React.useState<readonly StemView[]>([]);
  const [master, setMaster] = React.useState<AuthoredMaster>({ placements: [], durationFrames: "", targetLufs: "-16", truePeakDbtp: "-1" });
  const [pending, setPending] = React.useState<"stem" | "master" | null>(null);
  const [failure, setFailure] = React.useState<MasterFailure | null>(null);
  const [problems, setProblems] = React.useState<readonly Problem[]>([]);
  const [result, setResult] = React.useState<MasterView | null>(null);
  const stemAttempt = React.useRef<{ readonly fingerprint: string; readonly requestId: string } | null>(null);
  const masterAttempt = React.useRef<{ readonly fingerprint: string; readonly requestId: string } | null>(null);
  const resultHeading = React.useRef<HTMLHeadingElement | null>(null);
  const failureHeading = React.useRef<HTMLHeadingElement | null>(null);
  const root = React.useRef<HTMLElement | null>(null);
  const alive = React.useRef(true);

  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const loadStatus = React.useCallback(async (): Promise<void> => {
    setState({ phase: "loading" });
    try {
      const status = parseMasterStatus(await masters.getStatus());
      if (alive.current) {
        setState({ phase: "loaded", status });
        setMaster((current) => ({ ...current, targetLufs: String(status.defaultLufs), truePeakDbtp: String(status.defaultCeiling) }));
      }
    } catch (error) {
      if (alive.current) setState({ phase: "failed", failure: describeMasterFailure(error) });
    }
  }, [masters]);
  React.useEffect(() => { void loadStatus(); }, [loadStatus]);
  React.useEffect(() => { if (result) resultHeading.current?.focus(); }, [result?.masterId]);
  const focusPath = (path: string | null): void => {
    const target = path ? Array.from(root.current?.querySelectorAll<HTMLElement>("[data-spec-path]") ?? [])
      .find((element) => element.getAttribute("data-spec-path") === path) : undefined;
    (target ?? failureHeading.current)?.focus();
  };
  React.useEffect(() => { if (failure && !pending) focusPath(failure.path); }, [failure, pending]);

  const status = state.phase === "loaded" ? state.status : null;
  const busy = locked || pending !== null;
  const patchStem = (change: Partial<AuthoredStem>): void => { setStem({ ...stem, ...change }); setProblems([]); };
  const patchMaster = (change: Partial<AuthoredMaster>): void => { setMaster({ ...master, ...change }); setProblems([]); };
  const patchPlacement = (index: number, change: Partial<AuthoredPlacement>): void =>
    patchMaster({ placements: setAt(master.placements, index, { ...master.placements[index]!, ...change }) });

  const submitStem = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || !status?.stemReady) return;
    const { spec, problems: found } = toStemRequestSpec(stem);
    setProblems(found);
    if (found.length > 0) { setFailure(null); focusPath(found[0]!.path); return; }
    const fingerprint = JSON.stringify(spec);
    if (!stemAttempt.current || stemAttempt.current.fingerprint !== fingerprint) stemAttempt.current = { fingerprint, requestId: newRequestId() };
    setPending("stem"); setFailure(null);
    try {
      const view = parseStemView(await masters.generateStem({ requestId: stemAttempt.current.requestId, spec }));
      if (alive.current) setBuilt((list) => list.some((entry) => entry.artifact.artifactId === view.artifact.artifactId) ? list : [...list, view]);
    } catch (error) {
      if (alive.current) setFailure(describeMasterFailure(error));
    } finally { if (alive.current) setPending(null); }
  };

  const submitMaster = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || !status?.masterReady) return;
    const { request, problems: found } = toMasterRequest(master);
    setProblems(found);
    if (found.length > 0) { setFailure(null); focusPath(found[0]!.path); return; }
    const fingerprint = JSON.stringify(request);
    if (!masterAttempt.current || masterAttempt.current.fingerprint !== fingerprint) masterAttempt.current = { fingerprint, requestId: newRequestId() };
    setPending("master"); setFailure(null);
    try {
      const view = parseMasterView(await masters.master({ requestId: masterAttempt.current.requestId, ...request }));
      if (alive.current) setResult(view);
    } catch (error) {
      if (alive.current) { setFailure(describeMasterFailure(error)); setResult(null); }
    } finally { if (alive.current) setPending(null); }
  };

  const problemFor = (path: string): string | undefined => problems.find((problem) => problem.path === path)?.message;
  const field = (id: string, label: string, value: string, onChange: (value: string) => void, path: string, help?: string): React.ReactElement => {
    const message = problemFor(path);
    const describedBy = [help ? `${id}-help` : "", message ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
    return <div className="master-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" autoComplete="off" value={value} disabled={busy} data-spec-path={path} aria-invalid={message ? true : undefined}
        aria-describedby={describedBy} onChange={(event) => onChange(event.currentTarget.value)} />
      {help && <span id={`${id}-help`} className="master-help">{help}</span>}
      {message && <span id={`${id}-error`} className="master-error" role="alert">{message}</span>}
    </div>;
  };
  const select = (id: string, label: string, value: string, options: readonly string[], onChange: (value: string) => void, path: string): React.ReactElement =>
    <div className="master-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} disabled={busy} data-spec-path={path} onChange={(event) => onChange(event.currentTarget.value)}>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </div>;

  const m = result?.measurement;
  return <section ref={root} aria-labelledby="master-title" className="master" data-master-state={state.phase}>
    <h2 id="master-title">Stems, foley and master</h2>
    <p className="master-scope">DEV_ONLY. Stems are ORIGINAL audio that Media synthesizes from a recorded generator spec (no model, no third-party sample) or uploaded WAVs
      that carry a processing rights statement. Loudness and true peak are measured on the output samples. No rights clearance beyond those
      statements, no quality, approval or production claim.</p>

    <p role={state.phase === "failed" ? "alert" : "status"} aria-live="polite" aria-atomic="true" aria-busy={state.phase === "loading"} data-status-line>
      {state.phase === "loading" && "Reading the host's limits…"}
      {state.phase === "failed" && `${state.failure.code}: ${state.failure.text}`}
      {status && `The host builds stems of ${status.minStemMs} to ${status.maxStemMs} ms and masters up to ${status.maxMasterFrames} frames at ${status.sampleRateHz} Hz. ${status.masterReady ? "Mastering is available." : "Mastering is not available on this host."}`}
    </p>
    {state.phase === "failed" && <p><button type="button" onClick={() => void loadStatus()}>Retry reading limits</button></p>}

    <section aria-labelledby="master-stem-title" data-step="stems">
      <h3 id="master-stem-title">1. Build a stem</h3>
      <form onSubmit={(event) => void submitStem(event)} noValidate>
        <fieldset disabled={busy}><legend>Original procedural stem</legend>
          {select("master-stem-kind", "Kind", stem.kind, STEM_KINDS, (value) => patchStem({ kind: value as AuthoredStem["kind"] }), "$.spec.kind")}
          {field("master-stem-duration", "Duration (milliseconds)", stem.durationMs, (value) => patchStem({ durationMs: value }), "$.spec.durationMs")}
          {field("master-stem-channels", "Channels (1 or 2)", stem.channels, (value) => patchStem({ channels: value }), "$.spec.channels")}
          {field("master-stem-amplitude", "Peak level (dB below full scale, -60 to 0)", stem.amplitudeDb, (value) => patchStem({ amplitudeDb: value }), "$.spec.amplitudeDb")}
          {stem.kind === "TONE" && field("master-stem-frequency", "Frequency (Hz)", stem.frequencyHz, (value) => patchStem({ frequencyHz: value }), "$.spec.frequencyHz")}
          {stem.kind === "CHORD" && field("master-stem-frequencies", "Note frequencies (Hz, comma separated)", stem.frequenciesHz, (value) => patchStem({ frequenciesHz: value }), "$.spec.frequenciesHz")}
          {stem.kind === "DRUM" && select("master-stem-drum", "Drum", stem.drum, status?.drums ?? ["KICK", "SNARE", "HAT"], (value) => patchStem({ drum: value }), "$.spec.drum")}
          {stem.kind === "FOLEY" && select("master-stem-foley", "Foley", stem.foley, status?.foley ?? ["FOOTSTEP", "WHOOSH", "IMPACT"], (value) => patchStem({ foley: value }), "$.spec.foley")}
          {(stem.kind === "DRUM" || stem.kind === "FOLEY") && field("master-stem-seed", "Noise seed (whole number)", stem.seed, (value) => patchStem({ seed: value }), "$.spec.seed",
            "The same seed always gives the same sound.")}
        </fieldset>
        <p><button type="submit" disabled={busy || !status?.stemReady} aria-busy={pending === "stem"}>{pending === "stem" ? "Building…" : "Build stem"}</button></p>
      </form>
      <p role="status" aria-live="polite" aria-atomic="true" data-stem-status>{built.length === 0 ? "No stems built yet." : `${built.length} stem${built.length === 1 ? "" : "s"} built.`}</p>
      {built.length > 0 && <div className="master-scroll" role="region" aria-label="Built stems" tabIndex={0}><table data-stem-table>
        <caption>Stems built in this session (original procedural synthesis)</caption>
        <thead><tr><th scope="col">Stem</th><th scope="col">Kind</th><th scope="col">Length</th><th scope="col">Peak</th><th scope="col">Action</th></tr></thead>
        <tbody>{built.map((view) => <tr key={view.artifact.artifactId} data-stem-id={view.artifact.artifactId}>
          <th scope="row"><code>{view.artifact.artifactId}</code></th><td>{view.kind}, {view.channels === 1 ? "mono" : "stereo"}</td><td>{view.durationMs} ms</td>
          <td>{view.samplePeakDbfs === null ? "?" : `${fmt(view.samplePeakDbfs)} dBFS`}</td>
          <td><button type="button" disabled={busy} onClick={() => patchMaster({ placements: [...master.placements, blankPlacement(view.artifact.artifactId, view.artifact.artifactVersionId, `${view.kind} ${view.artifact.artifactId}`)] })}>
            Add {view.kind} {view.artifact.artifactId} to the mix</button></td>
        </tr>)}</tbody>
      </table></div>}
    </section>

    <section aria-labelledby="master-mix-title" data-step="mix">
      <h3 id="master-mix-title">2. Mix and master</h3>
      <form onSubmit={(event) => void submitMaster(event)} noValidate>
        {master.placements.length === 0 && <p>No stems in the mix. Add a built stem above, or add an uploaded stem by its exact artifact id and version.</p>}
        {master.placements.map((placement, index) => {
          const base = `$.stems[${index}]`;
          return <fieldset key={index} disabled={busy} data-placement-index={index}><legend>Stem {index + 1}{placement.label ? `: ${placement.label}` : ""}</legend>
            {field(`master-placement-${index}-artifact`, "Stem artifact id", placement.artifactId, (value) => patchPlacement(index, { artifactId: value }), `${base}.artifactId`)}
            {field(`master-placement-${index}-version`, "Exact version (sha256:…)", placement.artifactVersionId, (value) => patchPlacement(index, { artifactVersionId: value }), `${base}.artifactVersionId`)}
            {field(`master-placement-${index}-gain`, "Gain (dB, -60 to 12)", placement.gainDb, (value) => patchPlacement(index, { gainDb: value }), `${base}.gainDb`)}
            {field(`master-placement-${index}-pan`, "Pan (-1 left to 1 right)", placement.pan, (value) => patchPlacement(index, { pan: value }), `${base}.pan`)}
            {field(`master-placement-${index}-start`, "Start (samples at 48 kHz)", placement.startFrame, (value) => patchPlacement(index, { startFrame: value }), `${base}.startFrame`,
              "48 samples are 1 millisecond; the stem starts on exactly this sample.")}
            {field(`master-placement-${index}-fade-in`, "Fade in (samples)", placement.fadeInFrames, (value) => patchPlacement(index, { fadeInFrames: value }), `${base}.fadeInFrames`)}
            {field(`master-placement-${index}-fade-out`, "Fade out (samples)", placement.fadeOutFrames, (value) => patchPlacement(index, { fadeOutFrames: value }), `${base}.fadeOutFrames`)}
            <button type="button" onClick={() => patchMaster({ placements: master.placements.filter((_, i) => i !== index) })}>Remove stem {index + 1} from the mix</button>
          </fieldset>;
        })}
        <p><button type="button" disabled={busy} onClick={() => patchMaster({ placements: [...master.placements, blankPlacement()] })}>Add an uploaded stem to the mix</button></p>
        <p className="master-help">An uploaded stem must carry a processing rights statement made by its uploader for that exact version; this page never states rights.</p>
        <fieldset disabled={busy}><legend>Master target</legend>
          {field("master-target-lufs", "Integrated loudness target (LUFS, -30 to -9)", master.targetLufs, (value) => patchMaster({ targetLufs: value }), "$.target.integratedLufs")}
          {field("master-target-peak", "True-peak ceiling (dBTP, -6 to -0.1)", master.truePeakDbtp, (value) => patchMaster({ truePeakDbtp: value }), "$.target.truePeakDbtp")}
          {field("master-duration", "Master length (samples, optional)", master.durationFrames, (value) => patchMaster({ durationFrames: value }), "$.durationFrames",
            "Leave empty to end with the last stem. At least 19200 samples (400 ms).")}
        </fieldset>
        {problems.length > 0 && <ul role="alert" className="master-errors" data-problems>{problems.map((problem) =>
          <li key={problem.path}><code>{problem.path}</code> {problem.message}</li>)}</ul>}
        <p><button type="submit" disabled={busy || !status?.masterReady} aria-busy={pending === "master"}>{pending === "master" ? "Mastering…" : "Mix and master"}</button></p>
      </form>
    </section>

    <p role="status" aria-live="polite" aria-atomic="true" data-master-status>
      {pending === "master" ? "Mixing, mastering and encoding. The result is shown only after the host verifies and registers it." : result ? "Master registered." : "Nothing mastered yet."}
    </p>

    {failure && <div role="alert" className="master-failure" data-failure-code={failure.code} data-failure-tone={failure.tone}
      {...(failure.path ? { "data-failure-path": failure.path } : {})}>
      <h3 ref={failureHeading} tabIndex={-1}>{TONE_HEADING[failure.tone]}</h3>
      <p><code>{failure.code}</code> {failure.text}</p>
    </div>}

    {result && m && <section aria-labelledby="master-result-title" className="master-result" data-master-result data-master-id={result.masterId}>
      <h3 id="master-result-title" ref={resultHeading} tabIndex={-1}>Master result</h3>
      <p data-master-summary>
        {result.frames} samples ({fmt(result.durationSeconds, 3)} seconds), stereo 16-bit 48 kHz, {result.originalStems} original and {result.uploadedStems} uploaded stem{result.originalStems + result.uploadedStems === 1 ? "" : "s"}.
        {result.replayed ? " Replayed: the same request identifier returned the stored master." : " Created."}
      </p>
      <div className="master-scroll" role="region" aria-label="Loudness report" tabIndex={0}><table data-loudness-table>
        <caption>Loudness report, measured on the exact output samples</caption>
        <thead><tr><th scope="col">Measure</th><th scope="col">Result</th><th scope="col">Target</th></tr></thead>
        <tbody>
          <tr><th scope="row">Integrated loudness</th><td data-measure="integrated-lufs">{fmt(m.integratedLufs)} LUFS</td><td>{fmt(result.target.integratedLufs, 1)} LUFS</td></tr>
          <tr><th scope="row">True peak</th><td data-measure="true-peak">{fmt(m.truePeakDbtp)} dBTP</td><td>at most {fmt(result.target.truePeakDbtp, 1)} dBTP</td></tr>
          <tr><th scope="row">Sample peak</th><td data-measure="sample-peak">{fmt(m.samplePeakDbfs)} dBFS</td><td>not above the ceiling</td></tr>
          <tr><th scope="row">Clipped samples</th><td data-measure="clipped">{m.clippedSamples}</td><td>0</td></tr>
          <tr><th scope="row">Mix loudness before the master</th><td>{fmt(m.mixIntegratedLufs)} LUFS</td><td>not applicable</td></tr>
          <tr><th scope="row">Gain before the limiter</th><td>{fmt(m.preLimiterGainDb)} dB</td><td>not applicable</td></tr>
          <tr><th scope="row">Limiter</th><td>up to {fmt(m.maxGainReductionDb)} dB over {m.limitedFrames} samples</td><td>not applicable</td></tr>
        </tbody>
      </table></div>
      <p data-target-met role="status">{m.targetMet ? "The target and the ceiling are met on the output samples." : "The host reports the target is not met."}</p>
      <dl>
        <dt>FLAC check</dt><dd>{result.flacVerification}</dd>
        <dt>WAV</dt><dd><code>{result.wav.artifactId}</code> ({result.wav.sizeBytes ?? "?"} bytes)</dd>
        <dt>FLAC</dt><dd><code>{result.flac.artifactId}</code> ({result.flac.sizeBytes ?? "?"} bytes)</dd>
        <dt>Report</dt><dd><code>{result.reportArtifact.artifactId}</code></dd>
      </dl>
      <AudioPlayback key={`wav-${result.wav.artifactVersionId}`} reader={masters.readArtifactContent} artifact={result.wav} locked={locked} kind="WAV" label={`Mastered mix ${result.wav.artifactId}`} />
      <AudioPlayback key={`flac-${result.flac.artifactVersionId}`} reader={masters.readArtifactContent} artifact={result.flac} locked={locked} kind="FLAC" label={`Mastered mix, lossless ${result.flac.artifactId}`} />
      <details><summary>Lineage: every stem ({result.stems.length})</summary>
        <div className="master-scroll" role="region" aria-label="Stem lineage" tabIndex={0}><table data-lineage-table>
          <caption>Where every stem came from and where it sits in the mix</caption>
          <thead><tr><th scope="col">Stem</th><th scope="col">Origin</th><th scope="col">Start (sample)</th><th scope="col">Gain</th><th scope="col">Pan</th><th scope="col">Fades (in, out)</th></tr></thead>
          <tbody>{result.stems.map((line) => <tr key={line.index} data-stem-index={line.index}>
            <th scope="row"><code>{line.artifactId}</code></th><td>{line.origin === "ORIGINAL_PROCEDURAL_SYNTHESIS" ? "Original, synthesized by Media" : "Uploaded, with a processing rights statement"}</td>
            <td>{line.startFrame}</td><td>{fmt(line.gainDb, 1)} dB</td><td>{fmt(line.pan, 2)}</td><td>{line.fadeInFrames}, {line.fadeOutFrames}</td>
          </tr>)}</tbody>
        </table></div>
      </details>
    </section>}
  </section>;
}
