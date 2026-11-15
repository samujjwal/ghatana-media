import React from "react";
import {
  describeDubbingFailure, parseDubbingCapabilities, parseDubView, parseTranslationView,
  type DevDubbingPort, type DubbingCapabilities, type DubbingFailure, type DubbingTimingSegment, type DubView, type TranslationView,
} from "./devDubbing";
import { describeContentFailure, readVerifiedContent, type RegisteredArtifact } from "./devArtifactContent";

export interface DevDubbingPanelProps {
  readonly dubbing: DevDubbingPort;
  readonly locked?: boolean;
  /** Injectable for deterministic tests; must return a fresh opaque id per call. */
  readonly newRequestId?: () => string;
}

type CapabilitiesState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly failure: DubbingFailure }
  | { readonly phase: "loaded"; readonly capabilities: DubbingCapabilities };
type Step = "translate" | "revise" | "dub";
type Attempt = { readonly fingerprint: string; readonly requestId: string };

let counter = 0;
const defaultRequestId = (): string => {
  const random = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${(counter++).toString(36)}`;
  return `dub-${random}`;
};

const TONE_HEADING: Readonly<Record<DubbingFailure["tone"], string>> = {
  denied: "Denied", unsupported: "Not supported", unknown: "Outcome unknown", unavailable: "Unavailable", invalid: "Not registered",
  overflow: "Does not fit the source timing",
};
const FIT_TEXT: Readonly<Record<DubbingTimingSegment["fit"], string>> = {
  FITS: "Fits (no change)", TEMPO_ADJUSTED: "Fits after tempo adjustment", OVERFLOW: "Overflow",
};
const seconds = (millis: number): string => `${(millis / 1000).toFixed(2)} s`;

/** Timing-fit table shared by a finished dub and the typed overflow refusal. Status is text, never colour alone. */
function TimingTable({ segments, caption }: { readonly segments: readonly DubbingTimingSegment[]; readonly caption: string }): React.ReactElement {
  return <div className="dubbing-scroll" role="region" aria-label={caption} tabIndex={0}><table data-timing-table>
    <caption>{caption}</caption>
    <thead><tr>
      <th scope="col">Segment</th><th scope="col">Source window</th><th scope="col">Natural duration</th><th scope="col">Tempo factor</th>
      <th scope="col">Dub duration</th><th scope="col">Fit</th><th scope="col">Overflow</th>
    </tr></thead>
    <tbody>{segments.map((segment) => <tr key={segment.segmentId} data-segment-id={segment.segmentId} data-fit={segment.fit}>
      <th scope="row">{segment.segmentId}</th>
      <td>{seconds(segment.sourceStartMillis)} to {seconds(segment.sourceEndMillis)} ({segment.windowMillis} ms)</td>
      <td>{segment.naturalDurationMillis} ms</td>
      <td>{segment.tempoFactor.toFixed(4)}</td>
      <td>{segment.dubDurationMillis} ms</td>
      <td>{FIT_TEXT[segment.fit]}</td>
      <td>{segment.overflow ? `Yes, ${segment.overflowMillis} ms over the window` : "No"}</td>
    </tr>)}</tbody>
  </table></div>;
}

type Playback = { readonly phase: "idle" } | { readonly phase: "loading" }
  | { readonly phase: "verified"; readonly audioUrl: string; readonly captionsUrl: string; readonly text: string }
  | { readonly phase: "failed"; readonly text: string };

/** Loads the dub audio and its captions through the verified-content reader: playback starts only after both digests match. */
function DubPlayback({ reader, audio, captions, language, locked }: {
  readonly reader: DevDubbingPort["readArtifactContent"];
  readonly audio: RegisteredArtifact; readonly captions: RegisteredArtifact; readonly language: string; readonly locked: boolean;
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
      const options = { readArtifactContent: reader };
      const [audioBytes, captionBytes] = await Promise.all([readVerifiedContent(options, audio), readVerifiedContent(options, captions)]);
      const audioUrl = URL.createObjectURL(new Blob([audioBytes.bytes as BlobPart], { type: audioBytes.contentType }));
      const captionsUrl = URL.createObjectURL(new Blob([captionBytes.bytes as BlobPart], { type: captionBytes.contentType }));
      urls.current.push(audioUrl, captionsUrl);
      if (alive.current) {
        setState({ phase: "verified", audioUrl, captionsUrl,
          text: `Bytes verified against the registered versions: audio SHA-256 ${audioBytes.sha256} (${audioBytes.bytes.byteLength} bytes), captions SHA-256 ${captionBytes.sha256}.` });
      }
    } catch (error) {
      const shown = describeContentFailure(error);
      if (alive.current) setState({ phase: "failed", text: `${shown.code}: ${shown.text}` });
    }
  };
  return <section aria-label="Dubbed audio playback" data-playback-state={state.phase}>
    {!reader && <p role="note">This host exposes no DEV_ONLY content route to this page, so the dub cannot be played here.</p>}
    {reader && <p><button type="button" onClick={() => void load()} disabled={locked || state.phase === "loading" || state.phase === "verified"}>
      Load dubbed audio and captions (verify bytes first)</button></p>}
    <p role={state.phase === "failed" ? "alert" : "status"} aria-live="polite" aria-atomic="true" aria-busy={state.phase === "loading"} data-playback-status>
      {state.phase === "idle" && "Dubbed audio not loaded."}
      {state.phase === "loading" && "Reading the audio and captions and verifying their SHA-256…"}
      {state.phase === "verified" && state.text}
      {state.phase === "failed" && state.text}
    </p>
    {state.phase === "verified" && <audio controls preload="metadata" src={state.audioUrl} data-verified-preview="dub-audio"
      aria-label={`Dubbed ${language} audio ${audio.artifactId}`}>
      <track kind="captions" srcLang={language} label={`${language} captions`} src={state.captionsUrl} default />
    </audio>}
  </section>;
}

/**
 * DEV_ONLY translate-and-dub. The admitted languages, Spanish stock voices, tempo bounds and policies are read from the host and never
 * hard-coded. A transcript version is machine-translated segment by segment (ids and source-clock times kept), the translation can be
 * edited and saved as a new version, and only a saved host version can be dubbed. The dub is fitted to the source windows; a segment
 * that cannot fit is a typed refusal, never a silent truncation. Playback verifies the registered SHA-256 first. No voice cloning.
 */
export function DevDubbingPanel({ dubbing, locked = false, newRequestId = defaultRequestId }: DevDubbingPanelProps): React.ReactElement {
  const [state, setState] = React.useState<CapabilitiesState>({ phase: "loading" });
  const [transcriptId, setTranscriptId] = React.useState("");
  const [transcriptVersion, setTranscriptVersion] = React.useState("");
  const [target, setTarget] = React.useState("");
  const [voice, setVoice] = React.useState("");
  const [policy, setPolicy] = React.useState("REFUSE");
  const [working, setWorking] = React.useState<TranslationView | null>(null);
  const [edits, setEdits] = React.useState<Readonly<Record<string, string>>>({});
  const [pending, setPending] = React.useState<Step | null>(null);
  const [failure, setFailure] = React.useState<(DubbingFailure & { readonly step: Step }) | null>(null);
  const [formErrors, setFormErrors] = React.useState<readonly string[]>([]);
  const [dub, setDub] = React.useState<DubView | null>(null);
  const attempts = React.useRef<Partial<Record<Step, Attempt>>>({});
  const resultHeading = React.useRef<HTMLHeadingElement | null>(null);
  const segmentsHeading = React.useRef<HTMLHeadingElement | null>(null);
  const transcriptField = React.useRef<HTMLInputElement | null>(null);
  const alive = React.useRef(true);

  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const loadCapabilities = React.useCallback(async (): Promise<void> => {
    setState({ phase: "loading" });
    try {
      const response = await dubbing.getCapabilities();
      const capabilities = parseDubbingCapabilities(response.body);
      if (!alive.current) return;
      setState({ phase: "loaded", capabilities });
      setTarget((current) => capabilities.targets.includes(current) ? current : capabilities.targets[0] ?? "");
    } catch (error) {
      if (alive.current) setState({ phase: "failed", failure: describeDubbingFailure(error) });
    }
  }, [dubbing]);
  React.useEffect(() => { void loadCapabilities(); }, [loadCapabilities]);

  const capabilities = state.phase === "loaded" ? state.capabilities : null;
  const language = working?.targetLanguage ?? target;
  const voices = capabilities ? Object.entries(capabilities.voices).filter(([, voiceLanguage]) => voiceLanguage === language).map(([name]) => name).sort() : [];
  React.useEffect(() => { setVoice((current) => voices.includes(current) ? current : voices[0] ?? ""); }, [voices.join(",")]);
  React.useEffect(() => { if (working) segmentsHeading.current?.focus(); }, [working?.artifact.artifactVersionId]);
  React.useEffect(() => { if (dub) resultHeading.current?.focus(); }, [dub?.dubId]);

  const translateReady = !!capabilities && capabilities.translationReady && capabilities.targets.length > 0;
  const dubReady = !!capabilities && capabilities.dubbingReady && voices.length > 0;
  const busy = locked || pending !== null;
  const dirty = !!working && working.segments.some((segment) => (edits[segment.segmentId] ?? segment.text) !== segment.text);
  const maxChars = capabilities?.maxSegmentChars ?? 800;
  const attemptFor = (step: Step, fingerprint: string): string => {
    const current = attempts.current[step];
    if (!current || current.fingerprint !== fingerprint) attempts.current[step] = { fingerprint, requestId: newRequestId() };
    return attempts.current[step]!.requestId;
  };

  const run = async (step: Step, action: () => Promise<void>): Promise<void> => {
    setPending(step); setFailure(null);
    try { await action(); } catch (error) {
      if (alive.current) setFailure({ ...describeDubbingFailure(error), step });
    } finally { if (alive.current) setPending(null); }
  };

  const translate = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!capabilities || busy || !translateReady) return;
    const errors: string[] = [];
    if (!transcriptId.trim()) errors.push("Enter the transcript artifact id.");
    if (!/^sha256:[0-9a-f]{64}$/u.test(transcriptVersion.trim())) errors.push("Enter the exact transcript version as sha256: followed by 64 hexadecimal characters.");
    if (!target) errors.push("Choose a target language.");
    setFormErrors(errors);
    if (errors.length > 0) { transcriptField.current?.focus(); return; }
    const request = { transcriptArtifactId: transcriptId.trim(), transcriptArtifactVersionId: transcriptVersion.trim(), sourceLanguage: "en", targetLanguage: target };
    const requestId = attemptFor("translate", JSON.stringify(request));
    await run("translate", async () => {
      const view = parseTranslationView(await dubbing.translate({ requestId, ...request }));
      if (!alive.current) return;
      setWorking(view); setEdits({}); setDub(null);
    });
  };

  const save = async (): Promise<void> => {
    if (!working || !dirty || busy) return;
    const segments = working.segments.map((segment) => ({ segmentId: segment.segmentId, text: (edits[segment.segmentId] ?? segment.text).trim() }));
    if (segments.some((segment) => !segment.text || segment.text.length > maxChars)) {
      setFormErrors([`Every segment needs 1 to ${maxChars} characters of translation.`]);
      return;
    }
    setFormErrors([]);
    const base = { baseArtifactId: working.artifact.artifactId, baseArtifactVersionId: working.artifact.artifactVersionId };
    const requestId = attemptFor("revise", JSON.stringify([base, segments]));
    await run("revise", async () => {
      const view = parseTranslationView(await dubbing.revise({ requestId, ...base, segments }));
      if (!alive.current) return;
      setWorking(view); setEdits({}); setDub(null);
    });
  };

  const dubNow = async (): Promise<void> => {
    if (!working || dirty || busy || !dubReady) return;
    const request = { translatedArtifactId: working.artifact.artifactId, translatedArtifactVersionId: working.artifact.artifactVersionId,
      voice, overflowPolicy: policy };
    const requestId = attemptFor("dub", JSON.stringify(request));
    await run("dub", async () => {
      const view = parseDubView(await dubbing.dub({ requestId, ...request }));
      if (alive.current) setDub(view);
    });
  };

  const statusText = pending === "translate" ? "Translating with the local model. The result is shown only after the host registers it."
    : pending === "revise" ? "Saving the revision as a new version…"
    : pending === "dub" ? "Synthesizing and fitting the dub. The result is shown only after the host registers it."
    : dub ? "Dub registered." : working ? "Translation ready to edit." : "Nothing translated yet.";

  return <section aria-labelledby="dubbing-title" className="dubbing" data-dubbing-state={state.phase}>
    <h2 id="dubbing-title">Translate and dub</h2>
    <p className="dubbing-scope">DEV_ONLY machine translation and synthetic speech with stock voices. Unreviewed: no quality, lip-sync, approval or delivery claim. No voice cloning.</p>

    <p role={state.phase === "failed" ? "alert" : "status"} aria-live="polite" aria-atomic="true" aria-busy={state.phase === "loading"} data-capabilities-status>
      {state.phase === "loading" && "Reading the admitted languages and voices from the host…"}
      {state.phase === "failed" && `${state.failure.code}: ${state.failure.text}`}
      {capabilities && translateReady && `Translation is available from English to ${capabilities.targets.join(", ")}${capabilities.engineModel ? ` with ${capabilities.engineModel} (text only)` : ""}.`}
      {capabilities && !translateReady && "Translation is not available on this host. Nothing can be translated."}
    </p>
    {state.phase === "failed" && <p><button type="button" onClick={() => void loadCapabilities()}>Retry reading capabilities</button></p>}

    {capabilities && <aside aria-labelledby="dubbing-facts-title" className="dubbing-facts" data-dubbing-facts>
      <h3 id="dubbing-facts-title">What this host admits</h3>
      <dl>
        <dt>Target languages</dt><dd data-admitted-targets>{capabilities.targets.length ? capabilities.targets.join(", ") : "none"}</dd>
        <dt>Stock voices</dt><dd data-admitted-voices>{Object.keys(capabilities.voices).length
          ? Object.entries(capabilities.voices).map(([name, voiceLanguage]) => `${name} (${voiceLanguage})`).join(", ") : "none"}</dd>
        <dt>Voice cloning</dt><dd>{capabilities.voiceCloning === "NOT_SUPPORTED" ? "Not supported" : capabilities.voiceCloning ?? "unknown"}</dd>
        <dt>Tempo adjustment</dt><dd>{capabilities.tempoAvailable ? `speed-up from ${capabilities.tempoMin} to ${capabilities.tempoMax} times, pitch preserved` : "unavailable"}</dd>
        <dt>Overflow policies</dt><dd>{capabilities.overflowPolicies.join(", ") || "none"}</dd>
      </dl>
      {capabilities.lipTimingNote && <p>{capabilities.lipTimingNote}</p>}
    </aside>}

    <form onSubmit={(event) => void translate(event)} aria-describedby="dubbing-help" noValidate>
      <p id="dubbing-help">Enter an exact speech-transcript version produced by the speech lane. The host checks the rights statement of the original source.</p>
      <div className="dubbing-field">
        <label htmlFor="dubbing-transcript-id">Transcript artifact id</label>
        <input id="dubbing-transcript-id" ref={transcriptField} type="text" autoComplete="off" value={transcriptId} disabled={busy || !translateReady}
          aria-invalid={formErrors.length > 0 ? true : undefined} onChange={(event) => { setTranscriptId(event.currentTarget.value); setFormErrors([]); }} />
      </div>
      <div className="dubbing-field">
        <label htmlFor="dubbing-transcript-version">Transcript version (sha256:…)</label>
        <input id="dubbing-transcript-version" type="text" autoComplete="off" value={transcriptVersion} disabled={busy || !translateReady}
          onChange={(event) => { setTranscriptVersion(event.currentTarget.value); setFormErrors([]); }} />
      </div>
      <div className="dubbing-field">
        <label htmlFor="dubbing-target">Target language</label>
        <select id="dubbing-target" value={target} disabled={busy || !translateReady || working !== null} onChange={(event) => setTarget(event.currentTarget.value)}>
          {capabilities?.targets.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
        </select>
      </div>
      {formErrors.length > 0 && <ul role="alert" className="dubbing-errors">{formErrors.map((message) => <li key={message}>{message}</li>)}</ul>}
      <p><button type="submit" disabled={busy || !translateReady} aria-busy={pending === "translate"}>{pending === "translate" ? "Translating…" : "Translate"}</button></p>
    </form>

    <p role="status" aria-live="polite" aria-atomic="true" data-dubbing-status>{statusText}</p>

    {failure && <div role="alert" className="dubbing-failure" data-failure-code={failure.code} data-failure-tone={failure.tone} data-failure-step={failure.step}>
      <h3>{TONE_HEADING[failure.tone]}</h3>
      <p><code>{failure.code}</code> {failure.text}</p>
      {failure.overflowSegments && failure.overflowSegments.length > 0 && <ul data-overflow-segments>
        {failure.overflowSegments.map((segment) => <li key={segment.segmentId} data-overflow-segment={segment.segmentId}>
          {segment.segmentId}: natural duration {segment.naturalDurationMillis} ms in a {segment.windowMillis} ms window
          {segment.requiredTempoFactor !== null ? ` (needs a tempo factor of ${segment.requiredTempoFactor.toFixed(2)})` : ""}, {segment.overflowMillis} ms over at the maximum factor ({segment.reason || "reason not reported"}).
        </li>)}
      </ul>}
      {failure.fitSegments && failure.fitSegments.length > 0 && <TimingTable segments={failure.fitSegments} caption="Timing the host measured for the refused dub" />}
    </div>}

    {working && <section aria-labelledby="dubbing-segments-title" className="dubbing-segments" data-translation-version={working.artifact.artifactVersionId}>
      <h3 id="dubbing-segments-title" ref={segmentsHeading} tabIndex={-1}>Translation segments</h3>
      <p>
        {working.kind === "LOCAL_TRANSLATED_TRANSCRIPT_USER_REVISED" ? "Human-revised version" : "Machine translation"} <code>{working.artifact.artifactId}</code>,
        version <code>{working.artifact.artifactVersionId}</code>. Segment ids and source-clock times are fixed; only the text can be edited.
      </p>
      <div className="dubbing-scroll" role="region" aria-label="Segments and translations" tabIndex={0}><table data-segment-table>
        <caption>Source segments and editable {working.targetLanguage} translation</caption>
        <thead><tr><th scope="col">Segment</th><th scope="col">Source window</th><th scope="col">Source text</th><th scope="col">Translation</th></tr></thead>
        <tbody>{working.segments.map((segment) => {
          const value = edits[segment.segmentId] ?? segment.text;
          const inputId = `dubbing-text-${segment.segmentId}`;
          return <tr key={segment.segmentId} data-segment-id={segment.segmentId}>
            <th scope="row">{segment.segmentId}</th>
            <td>{seconds(segment.startMillis)} to {seconds(segment.endMillis)}</td>
            <td lang={working.sourceLanguage}>{segment.sourceText}</td>
            <td>
              <label htmlFor={inputId}>Translation of {segment.segmentId}</label>
              <textarea id={inputId} rows={3} lang={working.targetLanguage} value={value} maxLength={maxChars} disabled={busy}
                aria-describedby={`${inputId}-count`} onChange={(event) => setEdits({ ...edits, [segment.segmentId]: event.currentTarget.value })} />
              <span id={`${inputId}-count`} className="dubbing-count">{value.length} of {maxChars} characters{value !== segment.text ? " (edited, not saved)" : ""}</span>
            </td>
          </tr>;
        })}</tbody>
      </table></div>
      <p>
        <button type="button" onClick={() => void save()} disabled={busy || !dirty} aria-busy={pending === "revise"}>{pending === "revise" ? "Saving…" : "Save revision"}</button>
      </p>
      <div className="dubbing-field">
        <label htmlFor="dubbing-voice">Spanish stock voice</label>
        <select id="dubbing-voice" value={voice} disabled={busy || voices.length === 0} onChange={(event) => setVoice(event.currentTarget.value)}>
          {voices.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </div>
      <div className="dubbing-field">
        <label htmlFor="dubbing-policy">Overflow policy</label>
        <select id="dubbing-policy" value={policy} disabled={busy} onChange={(event) => setPolicy(event.currentTarget.value)}>
          {(capabilities?.overflowPolicies ?? []).map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </div>
      <p>
        <button type="button" onClick={() => void dubNow()} disabled={busy || dirty || !dubReady} aria-describedby="dubbing-dub-help" aria-busy={pending === "dub"}>
          {pending === "dub" ? "Dubbing…" : "Dub"}</button>
      </p>
      <p id="dubbing-dub-help" role="status" aria-live="polite" aria-atomic="true">
        {dirty ? "Save the revision first: only a saved version can be dubbed." : dubReady ? "Dubs the saved version exactly as shown." : "Dubbing is not available on this host."}
      </p>
    </section>}

    {dub && working && <section aria-labelledby="dubbing-result-title" className="dubbing-result" data-dub-result data-dub-id={dub.dubId}>
      <h3 id="dubbing-result-title" ref={resultHeading} tabIndex={-1}>Dub result</h3>
      <TimingTable segments={dub.timing.segments} caption="Timing fit of each dubbed segment" />
      <p data-timing-totals>
        Track {dub.timing.trackDurationMillis !== null ? seconds(dub.timing.trackDurationMillis) : "length not reported"}; voice {dub.timing.voice ?? "not reported"};
        policy {dub.timing.overflowPolicy ?? "not reported"}; {dub.timing.tempoAdjustedCount ?? 0} tempo-adjusted segment(s); {dub.timing.overflowCount ?? 0} overflowing segment(s).
        {dub.replayed ? " Replayed: the same request identifier returned the existing dub." : " Created."}
      </p>
      {dub.timing.lipTimingNote && <p data-lip-timing-note>{dub.timing.lipTimingNote}</p>}
      <dl>
        <dt>Audio</dt><dd><code>{dub.audio.artifactId}</code> <code>{dub.audio.artifactVersionId}</code></dd>
        <dt>Captions</dt><dd><code>{dub.captions.artifactId}</code> <code>{dub.captions.artifactVersionId}</code></dd>
        <dt>Timing metadata</dt><dd><code>{dub.timingArtifact.artifactId}</code></dd>
      </dl>
      <p>Disclosure: this is synthetic speech with a stock voice and an unreviewed machine or human-revised translation. Disclose it as synthetic when you share it.</p>
      <DubPlayback key={dub.audio.artifactVersionId} reader={dubbing.readArtifactContent} audio={dub.audio} captions={dub.captions}
        language={working.targetLanguage} locked={locked} />
    </section>}
  </section>;
}
