import React from "react";
import {
  describeVoiceFailure, languageLabel, parseVoiceCapabilities, parseVoiceSynthesisView,
  type DevVoiceSynthesisPort, type DevVoiceTimelinePlacement, type VoiceCapabilities, type VoiceFailure, type VoiceSynthesisView,
} from "./devVoiceSynthesis";
import { DevVerifiedContent } from "./DevVerifiedContent";

export interface VoiceSynthesisPanelProps {
  readonly voice: DevVoiceSynthesisPort;
  readonly locked?: boolean;
  /** Injectable for deterministic tests; must return a fresh opaque id per call. */
  readonly newRequestId?: () => string;
}

type CapabilitiesState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly failure: VoiceFailure }
  | { readonly phase: "loaded"; readonly capabilities: VoiceCapabilities };
type Attempt = { readonly fingerprint: string; readonly requestId: string };
type Synthesis = { readonly view: VoiceSynthesisView; readonly via: "created" | "replayed"; readonly requestId: string };
type Placement = { readonly phase: "idle" } | { readonly phase: "pending" }
  | { readonly phase: "placed"; readonly placement: DevVoiceTimelinePlacement } | { readonly phase: "failed"; readonly text: string };

let counter = 0;
const defaultRequestId = (): string => {
  const random = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${(counter++).toString(36)}`;
  return `voice-${random}`;
};

const TONE_HEADING: Readonly<Record<VoiceFailure["tone"], string>> = {
  denied: "Denied", unsupported: "Not supported", unknown: "Outcome unknown", unavailable: "Unavailable", invalid: "Not registered",
};

/**
 * DEV_ONLY voice synthesis. The voices, locales, limits, licence and attribution notice are read from the host and
 * never hard-coded; a stock-voice clip is synthesized from the typed text, verified against its registered SHA-256
 * before it can be played, and may be placed on a project timeline audio track. No voice cloning exists here.
 */
export function VoiceSynthesisPanel({ voice, locked = false, newRequestId = defaultRequestId }: VoiceSynthesisPanelProps): React.ReactElement {
  const [state, setState] = React.useState<CapabilitiesState>({ phase: "loading" });
  const [selectedVoice, setSelectedVoice] = React.useState("");
  const [selectedLocale, setSelectedLocale] = React.useState("");
  const [text, setText] = React.useState("");
  const [rate, setRate] = React.useState("1");
  const [pending, setPending] = React.useState(false);
  const [failure, setFailure] = React.useState<VoiceFailure | null>(null);
  const [formErrors, setFormErrors] = React.useState<readonly string[]>([]);
  const [shown, setShown] = React.useState<Synthesis | null>(null);
  const [placement, setPlacement] = React.useState<Placement>({ phase: "idle" });
  const attempt = React.useRef<Attempt | null>(null);
  const resultHeading = React.useRef<HTMLHeadingElement | null>(null);
  const textField = React.useRef<HTMLTextAreaElement | null>(null);
  const alive = React.useRef(true);

  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const loadCapabilities = React.useCallback(async (): Promise<void> => {
    setState({ phase: "loading" });
    try {
      const response = await voice.getCapabilities();
      const capabilities = parseVoiceCapabilities(response.body);
      if (!alive.current) return;
      setState({ phase: "loaded", capabilities });
      setSelectedVoice((current) => capabilities.voices.includes(current) ? current
        : capabilities.defaultVoice && capabilities.voices.includes(capabilities.defaultVoice) ? capabilities.defaultVoice : capabilities.voices[0] ?? "");
      setSelectedLocale((current) => capabilities.verifiedLanguages.includes(current) ? current : capabilities.verifiedLanguages[0] ?? "");
    } catch (error) {
      if (alive.current) setState({ phase: "failed", failure: describeVoiceFailure(error) });
    }
  }, [voice]);
  React.useEffect(() => { void loadCapabilities(); }, [loadCapabilities]);

  // A new result takes focus so keyboard and screen-reader users land on it.
  React.useEffect(() => { if (shown) resultHeading.current?.focus(); }, [shown]);

  const capabilities = state.phase === "loaded" ? state.capabilities : null;
  const usable = !!capabilities && capabilities.ready && capabilities.voices.length > 0 && capabilities.verifiedLanguages.length > 0;
  const disabled = locked || pending || !usable;

  const synthesize = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!capabilities || disabled) return;
    const errors: string[] = [];
    const trimmed = text.trim();
    if (!trimmed) errors.push("Enter the text to speak.");
    if (text.length > capabilities.maxTextChars) errors.push(`The text is limited to ${capabilities.maxTextChars} characters.`);
    const speakingRate = Number(rate);
    if (!rate.trim() || !Number.isFinite(speakingRate) || speakingRate < 0.5 || speakingRate > 2) errors.push("Speaking rate must be a number from 0.5 to 2.0.");
    if (!selectedVoice) errors.push("Choose a voice.");
    if (!selectedLocale) errors.push("Choose a locale.");
    setFormErrors(errors);
    if (errors.length > 0) { textField.current?.focus(); return; }

    // The same input keeps the same request identifier, so a retry after an unknown outcome can never duplicate.
    const fingerprint = JSON.stringify([selectedVoice, selectedLocale, speakingRate, text]);
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, requestId: newRequestId() };
    const requestId = attempt.current.requestId;
    setPending(true); setFailure(null); setPlacement({ phase: "idle" });
    try {
      const response = await voice.synthesize({ requestId, text, voice: selectedVoice, locale: selectedLocale, speakingRate });
      const view = parseVoiceSynthesisView(response);
      if (!alive.current) return;
      setShown({ view, via: view.replayed || response.status === 200 ? "replayed" : "created", requestId });
    } catch (error) {
      if (alive.current) { setShown(null); setFailure(describeVoiceFailure(error)); }
    } finally {
      if (alive.current) setPending(false);
    }
  };

  const addToTimeline = async (): Promise<void> => {
    if (!shown || !voice.addToTimeline || placement.phase === "pending") return;
    setPlacement({ phase: "pending" });
    try {
      const result = await voice.addToTimeline({
        clipId: `voice-${shown.requestId}`.slice(0, 128), artifactId: shown.view.artifact.artifactId,
        artifactVersionId: shown.view.artifact.artifactVersionId, sha256: shown.view.artifact.sha256,
        durationMillis: shown.view.durationMillis, sampleRate: shown.view.sampleRate,
      });
      if (alive.current) setPlacement({ phase: "placed", placement: result });
    } catch (error) {
      const described = describeVoiceFailure(error);
      if (alive.current) setPlacement({ phase: "failed", text: `${described.code}: ${described.text}` });
    }
  };

  return <section aria-labelledby="voice-synthesis-title" className="voice-synthesis" data-voice-state={state.phase}>
    <h2 id="voice-synthesis-title">Voice synthesis</h2>
    <p className="voice-scope">DEV_ONLY local text-to-speech with stock voices. No voice cloning; no quality, approval or delivery claim.</p>

    <p role={state.phase === "failed" ? "alert" : "status"} aria-live="polite" aria-atomic="true" aria-busy={state.phase === "loading"} data-capabilities-status>
      {state.phase === "loading" && "Reading the admitted voices and locales from the host…"}
      {state.phase === "failed" && `${state.failure.code}: ${state.failure.text}`}
      {capabilities && usable && `Model ${capabilities.modelId ?? "unknown"} is verified on this host with ${capabilities.voices.length} admitted voice${capabilities.voices.length === 1 ? "" : "s"}.`}
      {capabilities && !usable && `Voice synthesis is not available on this host (model state ${capabilities.installState}). Nothing can be synthesized.`}
    </p>
    {state.phase === "failed" && <p><button type="button" onClick={() => void loadCapabilities()}>Retry reading capabilities</button></p>}

    {capabilities && <aside aria-labelledby="voice-licence-title" className="voice-licence" data-voice-licence>
      <h3 id="voice-licence-title">Licence and attribution</h3>
      <p>
        Model <strong>{capabilities.modelId ?? "unknown"}</strong>{capabilities.revision ? <> (revision <code>{capabilities.revision}</code>)</> : null},
        licence <strong>{capabilities.licenseSpdx ?? "unknown"}</strong>.
      </p>
      {capabilities.attributionNotice
        ? <p data-attribution-notice>{capabilities.attributionNotice}{capabilities.noticeRequired ? " The notice must accompany redistribution." : ""}</p>
        : <p>The host returned no attribution notice.</p>}
      <p>Synthesized speech: disclose it as synthetic when you share it. Voice cloning is {capabilities.voiceCloning === "NOT_SUPPORTED" ? "not supported" : `reported as ${capabilities.voiceCloning ?? "unknown"}`} by this model.</p>
    </aside>}

    <form onSubmit={(event) => void synthesize(event)} aria-describedby="voice-synthesis-help" noValidate>
      <p id="voice-synthesis-help">Only voices and locales the installed model verifies are offered.</p>
      <div className="voice-field">
        <label htmlFor="voice-select">Voice</label>
        <select id="voice-select" value={selectedVoice} disabled={disabled} onChange={(event) => setSelectedVoice(event.currentTarget.value)}>
          {capabilities?.voices.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </div>
      <div className="voice-field">
        <label htmlFor="voice-locale">Locale</label>
        <select id="voice-locale" value={selectedLocale} disabled={disabled} onChange={(event) => setSelectedLocale(event.currentTarget.value)}>
          {capabilities?.verifiedLanguages.map((tag) => <option key={tag} value={tag}>{languageLabel(tag)}</option>)}
        </select>
      </div>
      <div className="voice-field">
        <label htmlFor="voice-text">Text to speak</label>
        <textarea id="voice-text" ref={textField} rows={4} value={text} disabled={disabled}
          maxLength={capabilities?.maxTextChars} aria-describedby="voice-text-count" aria-invalid={formErrors.length > 0 ? true : undefined}
          onChange={(event) => { setText(event.currentTarget.value); setFormErrors([]); }} />
        <p id="voice-text-count" className="voice-count">{text.length} of {capabilities?.maxTextChars ?? "…"} characters</p>
      </div>
      <div className="voice-field">
        <label htmlFor="voice-rate">Speaking rate (0.5 to 2.0)</label>
        <input id="voice-rate" type="number" inputMode="decimal" min={0.5} max={2} step={0.1} value={rate} disabled={disabled}
          onChange={(event) => { setRate(event.currentTarget.value); setFormErrors([]); }} />
      </div>
      {formErrors.length > 0 && <ul role="alert" className="voice-errors">{formErrors.map((message) => <li key={message}>{message}</li>)}</ul>}
      <p><button type="submit" disabled={disabled} aria-busy={pending}>{pending ? "Synthesizing…" : "Synthesize"}</button></p>
    </form>

    <p role="status" aria-live="polite" aria-atomic="true" data-synthesis-status>
      {pending ? "Synthesizing with the local model. The result is shown only after the host registers it." : shown ? "Synthesis registered." : "Nothing synthesized yet."}
    </p>

    {failure && <div role="alert" className="voice-failure" data-failure-code={failure.code} data-failure-tone={failure.tone}>
      <h3>{TONE_HEADING[failure.tone]}</h3>
      <p><code>{failure.code}</code> {failure.text}</p>
    </div>}

    {shown && <section aria-labelledby="voice-result-title" className="voice-result" data-synthesis-result>
      <h3 id="voice-result-title" ref={resultHeading} tabIndex={-1}>Synthesized clip</h3>
      <dl>
        <dt>Voice</dt><dd data-result-voice>{shown.view.voice}</dd>
        <dt>Locale</dt><dd>{shown.view.locale ?? "not reported"}</dd>
        <dt>Duration</dt><dd data-result-duration>{(shown.view.durationMillis / 1000).toFixed(2)} s</dd>
        <dt>Sample rate</dt><dd>{shown.view.sampleRate} Hz, mono</dd>
        <dt>Artifact</dt><dd><code>{shown.view.artifact.artifactId}</code></dd>
        <dt>Version</dt><dd><code>{shown.view.artifact.artifactVersionId}</code></dd>
        <dt>Outcome</dt><dd>{shown.via === "replayed" ? "Replayed: the same request identifier returned the existing clip." : "Created."}</dd>
      </dl>
      {shown.view.note && <p>{shown.view.note}</p>}
      <DevVerifiedContent key={shown.view.artifact.artifactVersionId} reader={voice.readArtifactContent ? { readArtifactContent: voice.readArtifactContent } : undefined}
        artifact={shown.view.artifact} kind="wav" locked={locked} />
      <p>
        <button type="button" onClick={() => void addToTimeline()} disabled={locked || !voice.addToTimeline || placement.phase === "pending"}
          aria-describedby="voice-timeline-status">{placement.phase === "pending" ? "Adding to timeline…" : "Add to timeline"}</button>
      </p>
      <p id="voice-timeline-status" role="status" aria-live="polite" aria-atomic="true" data-timeline-status={placement.phase}>
        {!voice.addToTimeline && "This host exposes no project timeline to this page."}
        {voice.addToTimeline && placement.phase === "idle" && "Places this exact version as an audio clip on a project timeline."}
        {placement.phase === "pending" && "Writing the audio clip to the timeline…"}
        {placement.phase === "placed" && `Added clip ${placement.placement.clipId} to audio track ${placement.placement.trackId} of project ${placement.placement.projectId} (revision ${placement.placement.revisionId}).`}
        {placement.phase === "failed" && placement.text}
      </p>
    </section>}
  </section>;
}
