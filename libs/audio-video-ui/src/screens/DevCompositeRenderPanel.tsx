import React from "react";
import {
  buildPlacementEdits, describeCompositeFailure, parseCompositeCapabilities, parseCompositeRender,
  type CompositeCapabilities, type CompositeClipRow, type CompositeFailure, type CompositeRenderRequest, type CompositeRenderView,
  type CompositeTrackKind, type DevCompositePort,
} from "./devCompositeRender";
import { DevVerifiedContent } from "./DevVerifiedContent";

export interface DevCompositeRenderPanelProps {
  readonly composite: DevCompositePort;
  readonly locked?: boolean;
  readonly newRequestId?: () => string;
}

let counter = 0;
const defaultRequestId = (): string => {
  const random = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${(counter++).toString(36)}`;
  return `composite-${random}`;
};

interface RowDraft { readonly key: number; readonly clipId: string; readonly trackId: string; readonly trackKind: CompositeTrackKind;
  readonly artifactId: string; readonly artifactVersionId: string; readonly sourceIn: string; readonly sourceOut: string; readonly start: string; readonly duration: string }
interface OverlayDraft { readonly key: number; readonly clipId: string; readonly x: string; readonly y: string; readonly opacity: string }
interface GainDraft { readonly key: number; readonly clipId: string; readonly gainDb: string }

const KINDS: readonly CompositeTrackKind[] = ["VIDEO", "AUDIO", "OVERLAY", "CAPTION"];
const whole = (value: string): number | null => /^\d{1,9}$/u.test(value.trim()) ? Number(value.trim()) : null;
const decimal = (value: string): number | null => value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;

/**
 * DEV_ONLY multitrack finished master. Place video, audio, overlay and caption clips on a project timeline (the existing timeline
 * routes), set the colour grade, overlay placement and audio gains, and render one H.264+AAC MP4 with FFmpeg. The result is played
 * only after its SHA-256 equals the registered one; every source version is listed. A typed refusal names the offending path.
 */
export function DevCompositeRenderPanel({ composite, locked = false, newRequestId = defaultRequestId }: DevCompositeRenderPanelProps): React.ReactElement {
  const [capabilities, setCapabilities] = React.useState<CompositeCapabilities | null>(null);
  const [capsFailure, setCapsFailure] = React.useState<CompositeFailure | null>(null);
  const [projectId, setProjectId] = React.useState("");
  const [timelineId, setTimelineId] = React.useState("timeline-main");
  const [revisionId, setRevisionId] = React.useState("");
  const [scaffold, setScaffold] = React.useState(false);
  const [rows, setRows] = React.useState<readonly RowDraft[]>([]);
  const [overlays, setOverlays] = React.useState<readonly OverlayDraft[]>([]);
  const [gains, setGains] = React.useState<readonly GainDraft[]>([]);
  const [width, setWidth] = React.useState("320");
  const [height, setHeight] = React.useState("240");
  const [fps, setFps] = React.useState("25");
  const [gap, setGap] = React.useState<"REFUSE" | "BLACK">("REFUSE");
  const [captions, setCaptions] = React.useState<"NONE" | "MUX" | "BURN" | "BOTH">("MUX");
  const [brightness, setBrightness] = React.useState("0");
  const [contrast, setContrast] = React.useState("1");
  const [saturation, setSaturation] = React.useState("1");
  const [pending, setPending] = React.useState<"place" | "render" | "head" | null>(null);
  const [status, setStatus] = React.useState("Nothing rendered yet.");
  const [failure, setFailure] = React.useState<CompositeFailure | null>(null);
  const [formErrors, setFormErrors] = React.useState<readonly string[]>([]);
  const [result, setResult] = React.useState<CompositeRenderView | null>(null);
  const activeRequest = React.useRef<string | null>(null);
  const attempt = React.useRef<{ fingerprint: string; requestId: string } | null>(null);
  const keyCounter = React.useRef(0);
  const resultHeading = React.useRef<HTMLHeadingElement | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  React.useEffect(() => {
    void (async () => {
      try {
        const loaded = parseCompositeCapabilities((await composite.getCapabilities()).body);
        if (alive.current) setCapabilities(loaded);
      } catch (error) { if (alive.current) setCapsFailure(describeCompositeFailure(error)); }
    })();
  }, [composite]);
  React.useEffect(() => { if (result) resultHeading.current?.focus(); }, [result?.renderId]);

  const nextKey = (): number => ++keyCounter.current;
  const busy = locked || pending !== null;
  const update = <T extends { readonly key: number }>(list: readonly T[], key: number, patch: Partial<T>): T[] => list.map((item) => item.key === key ? { ...item, ...patch } : item);

  const guard = async (kind: "place" | "render" | "head", work: () => Promise<void>): Promise<void> => {
    setPending(kind); setFailure(null);
    try { await work(); } catch (error) { if (alive.current) { const shown = describeCompositeFailure(error); setFailure(shown); setStatus(`${shown.code}: ${shown.text}`); } }
    finally { if (alive.current) setPending(null); }
  };

  const loadHead = async (): Promise<void> => {
    if (busy) return;
    if (!projectId.trim()) { setFormErrors(["Enter the project id."]); return; }
    setFormErrors([]);
    await guard("head", async () => {
      const body = (await composite.readHead(projectId.trim())).body as { currentRevision?: { revisionId?: unknown } } | null;
      const head = body?.currentRevision?.revisionId;
      if (typeof head !== "string" || !head) throw new Error("invalid head");
      setRevisionId(head); setStatus(`Head revision ${head} loaded.`);
    });
  };

  const place = async (): Promise<void> => {
    if (busy) return;
    const errors: string[] = [];
    if (!projectId.trim()) errors.push("Enter the project id.");
    if (!revisionId.trim()) errors.push("Enter the head revision id (Load head revision).");
    if (rows.length === 0) errors.push("Add at least one clip.");
    const parsed: CompositeClipRow[] = [];
    rows.forEach((row, index) => {
      const n = index + 1;
      const sourceInMs = whole(row.sourceIn), sourceOutMs = whole(row.sourceOut), storyStartMs = whole(row.start), storyDurationMs = whole(row.duration);
      if (!row.clipId.trim() || !row.trackId.trim() || !row.artifactId.trim()) errors.push(`Clip ${n}: clip id, track id and artifact id are required.`);
      if (!/^sha256:[0-9a-f]{64}$/u.test(row.artifactVersionId.trim())) errors.push(`Clip ${n}: the exact version must be sha256: followed by 64 hexadecimal characters.`);
      if (sourceInMs === null || sourceOutMs === null || storyStartMs === null || storyDurationMs === null || sourceOutMs <= sourceInMs || storyDurationMs <= 0) {
        errors.push(`Clip ${n}: times are whole milliseconds, source out after source in, duration above zero.`);
      } else {
        parsed.push({ clipId: row.clipId.trim(), trackId: row.trackId.trim(), trackKind: row.trackKind, artifactId: row.artifactId.trim(),
          artifactVersionId: row.artifactVersionId.trim(), sourceInMs, sourceOutMs, storyStartMs, storyDurationMs });
      }
    });
    setFormErrors(errors);
    if (errors.length > 0) return;
    await guard("place", async () => {
      const response = await composite.applyEdits(projectId.trim(), timelineId.trim(), revisionId.trim(), buildPlacementEdits(parsed, scaffold));
      const body = response.body as { revision?: { revisionId?: unknown } } | null;
      const head = body?.revision?.revisionId;
      if (typeof head !== "string" || !head) throw new Error("invalid revision");
      setRevisionId(head); setScaffold(false);
      setStatus(`Placed ${parsed.length} clip${parsed.length === 1 ? "" : "s"}; the new head revision ${head} is ready to render.`);
    });
  };

  const render = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const errors: string[] = [];
    const w = whole(width), h = whole(height), f = whole(fps);
    if (!projectId.trim() || !revisionId.trim() || !timelineId.trim()) errors.push("Project id, timeline id and revision id are required.");
    if (w === null || h === null || f === null || w % 2 !== 0 || h % 2 !== 0 || f < 1) errors.push("Width and height must be even whole numbers and frames per second a positive whole number.");
    const b = decimal(brightness), c = decimal(contrast), s = decimal(saturation);
    if (b === null || c === null || s === null) errors.push("Brightness, contrast and saturation must be numbers.");
    const overlayEntries = overlays.map((o) => ({ clipId: o.clipId.trim(), x: whole(o.x), y: whole(o.y), opacity: decimal(o.opacity) }));
    if (overlayEntries.some((o) => !o.clipId || o.x === null || o.y === null || o.opacity === null)) errors.push("Every overlay needs a clip id, whole-pixel x and y, and an opacity.");
    const gainEntries = gains.map((g) => ({ clipId: g.clipId.trim(), gainDb: decimal(g.gainDb) }));
    if (gainEntries.some((g) => !g.clipId || g.gainDb === null)) errors.push("Every audio gain needs a clip id and a gain in dB.");
    setFormErrors(errors);
    if (errors.length > 0) return;
    const request: Omit<CompositeRenderRequest, "requestId"> = {
      projectId: projectId.trim(), revisionId: revisionId.trim(), timelineId: timelineId.trim(), width: w!, height: h!, framesPerSecond: f!,
      gapPolicy: gap, captionMode: captions, color: { brightness: b!, contrast: c!, saturation: s! },
      overlays: overlayEntries.map((o) => ({ clipId: o.clipId, x: o.x!, y: o.y!, opacity: o.opacity! })),
      audio: gainEntries.map((g) => ({ clipId: g.clipId, gainDb: g.gainDb! })),
    };
    const fingerprint = JSON.stringify(request);
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, requestId: newRequestId() };
    const requestId = attempt.current.requestId;
    activeRequest.current = requestId;
    setResult(null);
    setStatus("Rendering with FFmpeg. The result is shown only after the host verifies and registers it.");
    await guard("render", async () => {
      try {
        const view = parseCompositeRender(await composite.render({ requestId, ...request }));
        if (alive.current) { setResult(view); setStatus(view.replayed ? "Render replayed (already registered)." : "Render registered."); }
      } finally { activeRequest.current = null; }
    });
  };

  const cancel = async (): Promise<void> => {
    const requestId = activeRequest.current;
    if (!requestId) return;
    try { await composite.cancel(requestId); setStatus("Cancel requested; waiting for the encoder to stop."); }
    catch (error) { const shown = describeCompositeFailure(error); setStatus(`${shown.code}: ${shown.text}`); }
  };

  const addRow = (kind: CompositeTrackKind): void => setRows((current) => [...current, {
    key: nextKey(), clipId: "", trackId: kind === "VIDEO" ? "video-main" : kind === "AUDIO" ? "audio-main" : kind === "OVERLAY" ? "overlay-main" : "caption-main",
    trackKind: kind, artifactId: "", artifactVersionId: "", sourceIn: "0", sourceOut: "1000", start: "0", duration: "1000" }]);
  const field = (label: string, value: string, set: (v: string) => void, extra: { readonly type?: string; readonly width?: number } = {}): React.ReactElement =>
    <label>{label}<input type={extra.type ?? "text"} value={value} onChange={(e) => set(e.target.value)} disabled={locked} autoComplete="off" /></label>;

  return <section aria-labelledby="composite-title" className="composite" data-composite-state={pending ?? (result ? "done" : "idle")}>
    <h2 id="composite-title">Multitrack finished master</h2>
    <p className="composite-scope">DEV_ONLY render of one project timeline into an H.264 and AAC MP4 by FFmpeg. Every source needs its own rights statement. A video clip's own audio is not used; sound comes from audio clips. No delivery or approval claim.</p>
    <p role={capsFailure ? "alert" : "status"} aria-live="polite" data-capabilities-status>
      {!capabilities && !capsFailure && "Reading the host limits…"}
      {capsFailure && `${capsFailure.code}: ${capsFailure.text}`}
      {capabilities && `Limits: ${capabilities.maxClips} clips, ${capabilities.maxTimelineSeconds} s, ${Math.round(capabilities.maxOutputBytes / 1048576)} MiB output.`}
    </p>

    <form onSubmit={(event) => void render(event)} aria-describedby="composite-status" noValidate>
      {formErrors.length > 0 && <div role="alert" data-form-errors><p>Fix before continuing:</p><ul>{formErrors.map((message) => <li key={message}>{message}</li>)}</ul></div>}
      <fieldset disabled={locked}><legend>Project and timeline</legend>
        {field("Project id", projectId, setProjectId)}
        {field("Timeline id", timelineId, setTimelineId)}
        {field("Head revision id", revisionId, setRevisionId)}
        <button type="button" onClick={() => void loadHead()} disabled={busy}>Load head revision</button>
      </fieldset>

      <fieldset disabled={locked}><legend>Clips on the timeline</legend>
        <p>Add clips by track kind. Times are whole milliseconds; a video clip is trimmed by its source in and out and placed at its story start. Clips are never retimed.</p>
        {rows.map((row, index) => <div key={row.key} role="group" aria-label={`Clip ${index + 1}`} data-clip-row>
          <label>Clip id<input value={row.clipId} onChange={(e) => setRows((c) => update(c, row.key, { clipId: e.target.value }))} autoComplete="off" /></label>
          <label>Track id<input value={row.trackId} onChange={(e) => setRows((c) => update(c, row.key, { trackId: e.target.value }))} autoComplete="off" /></label>
          <label>Track kind<select value={row.trackKind} onChange={(e) => setRows((c) => update(c, row.key, { trackKind: e.target.value as CompositeTrackKind }))}>
            {KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
          <label>Artifact id<input value={row.artifactId} onChange={(e) => setRows((c) => update(c, row.key, { artifactId: e.target.value }))} autoComplete="off" /></label>
          <label>Exact version<input value={row.artifactVersionId} onChange={(e) => setRows((c) => update(c, row.key, { artifactVersionId: e.target.value }))} autoComplete="off" /></label>
          <label>Source in (ms)<input inputMode="numeric" value={row.sourceIn} onChange={(e) => setRows((c) => update(c, row.key, { sourceIn: e.target.value }))} /></label>
          <label>Source out (ms)<input inputMode="numeric" value={row.sourceOut} onChange={(e) => setRows((c) => update(c, row.key, { sourceOut: e.target.value }))} /></label>
          <label>Story start (ms)<input inputMode="numeric" value={row.start} onChange={(e) => setRows((c) => update(c, row.key, { start: e.target.value }))} /></label>
          <label>Story duration (ms)<input inputMode="numeric" value={row.duration} onChange={(e) => setRows((c) => update(c, row.key, { duration: e.target.value }))} /></label>
          <button type="button" onClick={() => setRows((c) => c.filter((r) => r.key !== row.key))}>Remove clip {index + 1}</button>
        </div>)}
        <p>{KINDS.map((kind) => <button key={kind} type="button" onClick={() => addRow(kind)} disabled={busy}>Add {kind.toLowerCase()} clip</button>)}</p>
        <label><input type="checkbox" checked={scaffold} onChange={(e) => setScaffold(e.target.checked)} /> Create the scene and tracks first (first placement on a new timeline)</label>
        <p><button type="button" onClick={() => void place()} disabled={busy || rows.length === 0}>Place clips on the timeline</button></p>
      </fieldset>

      <fieldset disabled={locked}><legend>Render settings</legend>
        {field("Width (px)", width, setWidth)}
        {field("Height (px)", height, setHeight)}
        {field("Frames per second", fps, setFps)}
        <label>Gaps in the picture<select value={gap} onChange={(e) => setGap(e.target.value as "REFUSE" | "BLACK")}>
          <option value="REFUSE">Refuse (typed error)</option><option value="BLACK">Fill with black</option></select></label>
        <label>Captions<select value={captions} onChange={(e) => setCaptions(e.target.value as typeof captions)}>
          <option value="NONE">None (refused when caption clips exist)</option><option value="MUX">Muxed subtitle stream</option>
          <option value="BURN">Burned into the picture</option><option value="BOTH">Muxed and burned</option></select></label>
        {field("Brightness (-0.5 to 0.5)", brightness, setBrightness)}
        {field("Contrast (0.5 to 2)", contrast, setContrast)}
        {field("Saturation (0 to 3)", saturation, setSaturation)}
        <h3>Graphic overlays</h3>
        {overlays.map((o, index) => <div key={o.key} role="group" aria-label={`Overlay ${index + 1}`}>
          <label>Overlay clip id<input value={o.clipId} onChange={(e) => setOverlays((c) => update(c, o.key, { clipId: e.target.value }))} autoComplete="off" /></label>
          <label>X (px)<input inputMode="numeric" value={o.x} onChange={(e) => setOverlays((c) => update(c, o.key, { x: e.target.value }))} /></label>
          <label>Y (px)<input inputMode="numeric" value={o.y} onChange={(e) => setOverlays((c) => update(c, o.key, { y: e.target.value }))} /></label>
          <label>Opacity (0 to 1)<input value={o.opacity} onChange={(e) => setOverlays((c) => update(c, o.key, { opacity: e.target.value }))} /></label>
          <button type="button" onClick={() => setOverlays((c) => c.filter((r) => r.key !== o.key))}>Remove overlay {index + 1}</button>
        </div>)}
        <button type="button" onClick={() => setOverlays((c) => [...c, { key: nextKey(), clipId: "", x: "0", y: "0", opacity: "1" }])}>Add overlay placement</button>
        <h3>Audio gains</h3>
        {gains.map((g, index) => <div key={g.key} role="group" aria-label={`Audio gain ${index + 1}`}>
          <label>Audio clip id<input value={g.clipId} onChange={(e) => setGains((c) => update(c, g.key, { clipId: e.target.value }))} autoComplete="off" /></label>
          <label>Gain (dB)<input value={g.gainDb} onChange={(e) => setGains((c) => update(c, g.key, { gainDb: e.target.value }))} /></label>
          <button type="button" onClick={() => setGains((c) => c.filter((r) => r.key !== g.key))}>Remove gain {index + 1}</button>
        </div>)}
        <button type="button" onClick={() => setGains((c) => [...c, { key: nextKey(), clipId: "", gainDb: "0" }])}>Add audio gain</button>
      </fieldset>

      <p>
        <button type="submit" disabled={busy}>Render finished master</button>
        <button type="button" onClick={() => void cancel()} disabled={pending !== "render"}>Cancel render</button>
      </p>
    </form>

    <p id="composite-status" role={failure ? "alert" : "status"} aria-live="polite" aria-atomic="true" aria-busy={pending === "render"} data-composite-status>{status}</p>
    {failure && <dl data-failure data-tone={failure.tone}><dt>Outcome</dt><dd>{failure.code}</dd>{failure.path && <><dt>Path</dt><dd data-failure-path>{failure.path}</dd></>}</dl>}

    {result && <section aria-labelledby="composite-result" data-composite-result>
      <h3 id="composite-result" tabIndex={-1} ref={resultHeading}>Finished master {result.replayed ? "(replayed)" : ""}</h3>
      <dl>
        <dt>Picture</dt><dd data-result-picture>{result.width} x {result.height} at {result.framesPerSecond} fps, {result.frameCount} frames ({result.durationSeconds} s)</dd>
        <dt>Streams</dt><dd data-result-streams>video {result.measured.videoCodec}, audio {result.measured.audioCodec}, subtitles {result.measured.subtitleCodec}</dd>
        <dt>Captions</dt><dd>{result.captionMode} ({result.captionCueCount} cues)</dd>
        <dt>Size</dt><dd data-result-size>{result.artifact.sizeBytes ?? "unknown"} bytes</dd>
        <dt>SHA-256</dt><dd data-result-sha256>{result.artifact.sha256}</dd>
      </dl>
      <div role="region" aria-label="Source versions" tabIndex={0}><table data-sources>
        <caption>Exact source versions used (erasure follows these)</caption>
        <thead><tr><th scope="col">Clip</th><th scope="col">Track</th><th scope="col">Artifact</th><th scope="col">Version</th></tr></thead>
        <tbody>{result.sources.map((source) => <tr key={source.clipId} data-source-clip={source.clipId}><th scope="row">{source.clipId}</th><td>{source.trackKind}</td>
          <td>{source.artifactId}</td><td>{source.artifactVersionId}</td></tr>)}</tbody>
      </table></div>
      <DevVerifiedContent key={result.artifact.artifactVersionId} reader={composite.readArtifactContent ? { readArtifactContent: composite.readArtifactContent } : undefined}
        artifact={result.artifact} kind="mp4" locked={locked} maxBytes={64 * 1024 * 1024} />
    </section>}
  </section>;
}
