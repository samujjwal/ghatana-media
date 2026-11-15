import React from "react";
import {
  describeRegionFailure, frameAt, parseRegionEditStatus, parseRegionLineage, parseRegionOutcome, registeredVideo,
  type DevRegionEditPort, type RegionEditStatus, type RegionFailure, type RegionLineageView, type RegionManifest, type RegionOutcome, type RegionVersion,
} from "./devRegionEdit";
import { describeContentFailure, readVerifiedContent } from "./devArtifactContent";

export interface DevRegionEditPanelProps {
  readonly regionEdit: DevRegionEditPort;
  readonly locked?: boolean;
  /** Injectable for deterministic tests; must return a fresh opaque id per call. */
  readonly newRequestId?: () => string;
}

type StatusState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly failure: RegionFailure }
  | { readonly phase: "loaded"; readonly status: RegionEditStatus };

let counter = 0;
const defaultRequestId = (): string => {
  const random = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${(counter++).toString(36)}`;
  return `region-${random}`;
};

const TONE_HEADING: Readonly<Record<RegionFailure["tone"], string>> = {
  invalid: "Request not valid", denied: "Denied", untrusted: "Tracks input refused", notFound: "Not found", conflict: "Conflict",
  unknown: "Outcome unknown", unavailable: "Unavailable",
};

type Playback = { readonly phase: "idle" } | { readonly phase: "loading" }
  | { readonly phase: "verified"; readonly url: string; readonly text: string } | { readonly phase: "failed"; readonly text: string };

/** Loads the edited MP4 through the verified-content reader and draws the manifest's mask of the shown frame over it. */
function MaskedPlayback({ reader, version, manifest, locked }: {
  readonly reader: DevRegionEditPort["readArtifactContent"]; readonly version: RegionVersion; readonly manifest: RegionManifest; readonly locked: boolean;
}): React.ReactElement {
  const [state, setState] = React.useState<Playback>({ phase: "idle" });
  const [shown, setShown] = React.useState<string>("No frame shown yet.");
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const urls = React.useRef<string[]>([]);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; for (const url of urls.current) URL.revokeObjectURL(url); urls.current = []; };
  }, []);

  const draw = React.useCallback((): void => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const frame = frameAt(manifest.frames, video.currentTime);
    const context = canvas.getContext("2d");
    context?.clearRect(0, 0, canvas.width, canvas.height);
    const mask = frame?.mask ?? null;
    if (context && mask) {
      context.lineWidth = 2;
      context.strokeStyle = "#ffff00";
      context.strokeRect(mask.x + 1, mask.y + 1, Math.max(1, mask.width - 2), Math.max(1, mask.height - 2));
    }
    canvas.dataset.frameIndex = frame ? String(frame.frameIndex) : "";
    canvas.dataset.mask = mask ? `${mask.x},${mask.y},${mask.width},${mask.height}` : "none";
    setShown(frame ? `Frame ${frame.frameIndex}: ${mask ? `mask at x ${mask.x}, y ${mask.y}, ${mask.width} by ${mask.height}` : "no mask on this frame"}.` : "No frame shown yet.");
  }, [manifest]);

  React.useEffect(() => {
    const video = videoRef.current;
    if (state.phase !== "verified" || !video) return;
    const redraw = (): void => draw();
    video.addEventListener("timeupdate", redraw);
    video.addEventListener("seeked", redraw);
    video.addEventListener("loadeddata", redraw);
    let handle = 0;
    const withCallback = video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number; cancelVideoFrameCallback?: (id: number) => void };
    const loop = (): void => { draw(); handle = withCallback.requestVideoFrameCallback!(loop); };
    if (withCallback.requestVideoFrameCallback) handle = withCallback.requestVideoFrameCallback(loop);
    return () => {
      video.removeEventListener("timeupdate", redraw); video.removeEventListener("seeked", redraw); video.removeEventListener("loadeddata", redraw);
      if (handle && withCallback.cancelVideoFrameCallback) withCallback.cancelVideoFrameCallback(handle);
    };
  }, [state.phase, draw]);

  const load = async (): Promise<void> => {
    if (!reader || state.phase === "loading") return;
    setState({ phase: "loading" });
    try {
      const verified = await readVerifiedContent({ readArtifactContent: reader }, registeredVideo(version));
      const url = URL.createObjectURL(new Blob([verified.bytes as BlobPart], { type: verified.contentType }));
      urls.current.push(url);
      if (alive.current) setState({ phase: "verified", url, text: `Bytes verified against the registered version: SHA-256 ${verified.sha256} (${verified.bytes.byteLength} bytes).` });
    } catch (error) {
      const failure = describeContentFailure(error);
      if (alive.current) setState({ phase: "failed", text: `${failure.code}: ${failure.text}` });
    }
  };
  return <section aria-label="Edited video playback" data-playback-state={state.phase}>
    {!reader && <p role="note">This host exposes no DEV_ONLY content route to this page, so the video cannot be played here.</p>}
    {reader && <p><button type="button" onClick={() => void load()} disabled={locked || state.phase === "loading" || state.phase === "verified"}>
      Load the edited video (verify bytes first)</button></p>}
    <p role={state.phase === "failed" ? "alert" : "status"} aria-live="polite" aria-atomic="true" aria-busy={state.phase === "loading"} data-playback-status>
      {state.phase === "idle" && "Video not loaded."}
      {state.phase === "loading" && "Reading the video and verifying its SHA-256…"}
      {(state.phase === "verified" || state.phase === "failed") && state.text}
    </p>
    {state.phase === "verified" && <div className="region-stage">
      <video ref={videoRef} controls preload="auto" muted playsInline src={state.url} data-verified-preview="region-edit-video"
        aria-label={`Edited video version ${version.versionNumber}`} />
      <canvas ref={canvasRef} width={manifest.width} height={manifest.height} className="region-overlay" data-mask-overlay role="img"
        aria-label="Outline of the edit mask on the frame shown" />
      <p data-shown-frame role="status" aria-live="polite">{shown}</p>
    </div>}
  </section>;
}

const hex = (value: string): string => `${value.slice(0, 12)}…`;

/**
 * DEV_ONLY tracked region edit: name a stored video as version 1 of a lineage, apply a blur, pixelate or fill inside a mask
 * that follows a host-produced track, and step back with undo. Every change is a NEW immutable version; each request
 * names the head version this page last saw, so a concurrent change is a typed conflict and never a silent overwrite.
 * The result is shown only after the host verified and registered it; the video plays only after its SHA-256 matches.
 */
export function DevRegionEditPanel({ regionEdit, locked = false, newRequestId = defaultRequestId }: DevRegionEditPanelProps): React.ReactElement {
  const [state, setState] = React.useState<StatusState>({ phase: "loading" });
  const [lineageId, setLineageId] = React.useState("");
  const [videoId, setVideoId] = React.useState("");
  const [videoVersion, setVideoVersion] = React.useState("");
  const [tracksId, setTracksId] = React.useState("");
  const [tracksVersion, setTracksVersion] = React.useState("");
  const [trackId, setTrackId] = React.useState("");
  const [effect, setEffect] = React.useState("PIXELATE");
  const [blockSize, setBlockSize] = React.useState("8");
  const [radius, setRadius] = React.useState("8");
  const [color, setColor] = React.useState("#000000");
  const [padding, setPadding] = React.useState("4");
  const [maxDrift, setMaxDrift] = React.useState("");
  const [encoder, setEncoder] = React.useState("0");
  const [lineage, setLineage] = React.useState<RegionLineageView | null>(null);
  const [result, setResult] = React.useState<RegionOutcome | null>(null);
  const [message, setMessage] = React.useState("No lineage loaded.");
  const [pending, setPending] = React.useState(false);
  const [failure, setFailure] = React.useState<RegionFailure | null>(null);
  const [problems, setProblems] = React.useState<readonly { readonly path: string; readonly message: string }[]>([]);
  const attempt = React.useRef<{ readonly fingerprint: string; readonly requestId: string } | null>(null);
  const resultHeading = React.useRef<HTMLHeadingElement | null>(null);
  const failureHeading = React.useRef<HTMLHeadingElement | null>(null);
  const root = React.useRef<HTMLElement | null>(null);
  const alive = React.useRef(true);

  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const loadStatus = React.useCallback(async (): Promise<void> => {
    setState({ phase: "loading" });
    try {
      const status = parseRegionEditStatus(await regionEdit.getStatus());
      if (alive.current) setState({ phase: "loaded", status });
    } catch (error) {
      if (alive.current) setState({ phase: "failed", failure: describeRegionFailure(error) });
    }
  }, [regionEdit]);
  React.useEffect(() => { void loadStatus(); }, [loadStatus]);
  React.useEffect(() => { if (result) resultHeading.current?.focus(); }, [result?.version.versionNumber, result?.version.requestId]);
  const focusPath = (path: string | null): void => {
    const all = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-spec-path]") ?? []);
    const target = path ? (all.find((element) => element.getAttribute("data-spec-path") === path)
      ?? all.find((element) => path.startsWith(`${element.getAttribute("data-spec-path")}.`))) : undefined;
    (target ?? failureHeading.current)?.focus();
  };
  React.useEffect(() => { if (failure && !pending) focusPath(failure.path); }, [failure, pending]);

  const status = state.phase === "loaded" ? state.status : null;
  const ready = !!status && status.ready;
  const busy = locked || pending;
  const head = lineage?.headVersion ?? null;

  const guard = async (work: () => Promise<void>): Promise<void> => {
    setPending(true); setFailure(null);
    try { await work(); } catch (error) {
      const shown = describeRegionFailure(error);
      if (alive.current) setFailure(shown);
    } finally { if (alive.current) setPending(false); }
  };

  const openLineage = (reload: boolean): Promise<void> => guard(async () => {
    if (!lineageId.trim()) { setProblems([{ path: "$.lineageId", message: "Enter a lineage id." }]); focusPath("$.lineageId"); return; }
    const view = parseRegionLineage(await regionEdit.getLineage(lineageId.trim()));
    if (alive.current) {
      setLineage(view); setResult(null); setProblems([]);
      setMessage(`${reload ? "Reloaded" : "Loaded"} lineage ${view.lineageId}: head is version ${view.headVersion}.`);
    }
  });

  const createLineage = (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || !ready) return Promise.resolve();
    const found = [
      ...(lineageId.trim() ? [] : [{ path: "$.lineageId", message: "Enter a lineage id." }]),
      ...(videoId.trim() ? [] : [{ path: "$.artifactId", message: "Enter the video artifact id." }]),
      ...(/^sha256:[0-9a-f]{64}$/u.test(videoVersion.trim()) ? [] : [{ path: "$.artifactVersionId", message: "Enter the exact version, sha256: followed by 64 hex digits." }]),
    ];
    setProblems(found);
    if (found.length > 0) { focusPath(found[0]!.path); return Promise.resolve(); }
    return guard(async () => {
      const view = parseRegionLineage(await regionEdit.createLineage({ lineageId: lineageId.trim(), artifactId: videoId.trim(), artifactVersionId: videoVersion.trim() }));
      if (alive.current) {
        setLineage(view); setResult(null);
        setMessage(view.created === false ? `Lineage ${view.lineageId} already named this video: head is version ${view.headVersion}.`
          : `Lineage ${view.lineageId} created: version 1 is your video, unchanged.`);
      }
    });
  };

  const requestFor = (fingerprint: string): string => {
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, requestId: newRequestId() };
    return attempt.current.requestId;
  };

  const submitEdit = (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || !ready || !lineage) return Promise.resolve();
    const found: { path: string; message: string }[] = [];
    const whole = (value: string): number | null => /^-?\d+$/u.test(value.trim()) ? Number(value.trim()) : null;
    if (!tracksId.trim()) found.push({ path: "$.track.artifactId", message: "Enter the tracks artifact id." });
    if (!/^sha256:[0-9a-f]{64}$/u.test(tracksVersion.trim())) found.push({ path: "$.track.artifactVersionId", message: "Enter the exact version, sha256: followed by 64 hex digits." });
    if (!trackId.trim()) found.push({ path: "$.track.trackId", message: "Enter the track id inside the tracks document." });
    const paddingValue = whole(padding);
    if (paddingValue === null) found.push({ path: "$.paddingPx", message: "Enter a whole number." });
    let effectBody: Record<string, unknown> = { type: effect };
    if (effect === "PIXELATE") { const v = whole(blockSize); if (v === null) found.push({ path: "$.effect.blockSize", message: "Enter a whole number." }); else effectBody = { type: effect, blockSize: v }; }
    if (effect === "BLUR") { const v = whole(radius); if (v === null) found.push({ path: "$.effect.radius", message: "Enter a whole number." }); else effectBody = { type: effect, radius: v }; }
    if (effect === "FILL") { if (!/^#[0-9A-Fa-f]{6}$/u.test(color.trim())) found.push({ path: "$.effect.color", message: "Enter #RRGGBB." }); else effectBody = { type: effect, color: color.trim() }; }
    let driftValue: number | undefined;
    if (maxDrift.trim()) { const n = Number(maxDrift.trim()); if (!Number.isFinite(n)) found.push({ path: "$.maxDriftPx", message: "Enter a number." }); else driftValue = n; }
    setProblems(found);
    if (found.length > 0) { setFailure(null); focusPath(found[0]!.path); return Promise.resolve(); }
    const body = { baseVersion: lineage.headVersion, track: { artifactId: tracksId.trim(), artifactVersionId: tracksVersion.trim(), trackId: trackId.trim() },
      effect: effectBody, paddingPx: paddingValue!, ...(driftValue === undefined ? {} : { maxDriftPx: driftValue }), encoder: { crf: Number(encoder) } };
    const requestId = requestFor(JSON.stringify({ lineageId: lineage.lineageId, ...body }));
    return guard(async () => {
      const outcome = parseRegionOutcome(await regionEdit.edit(lineage.lineageId, { requestId, ...body }));
      if (alive.current) {
        setLineage(outcome.lineage); setResult(outcome);
        setMessage(`${outcome.replayed ? "Replayed" : "Created"} version ${outcome.version.versionNumber}; the head is version ${outcome.lineage.headVersion}.`);
      }
    });
  };

  const submitUndo = (): Promise<void> => {
    if (busy || !ready || !lineage || !lineage.undoAvailable) return Promise.resolve();
    const body = { baseVersion: lineage.headVersion };
    const requestId = requestFor(JSON.stringify({ undo: lineage.lineageId, ...body }));
    return guard(async () => {
      const outcome = parseRegionOutcome(await regionEdit.undo(lineage.lineageId, { requestId, ...body }));
      if (alive.current) {
        setLineage(outcome.lineage); setResult(outcome);
        setMessage(`${outcome.replayed ? "Replayed" : "Undone"}: version ${outcome.version.versionNumber} restores version ${outcome.version.restoresVersionNumber}; the head is version ${outcome.lineage.headVersion}.`);
      }
    });
  };

  const problemFor = (path: string): string | undefined => problems.find((problem) => problem.path === path)?.message;
  const field = (id: string, label: string, value: string, onChange: (value: string) => void, path: string): React.ReactElement => {
    const problem = problemFor(path);
    return <div className="region-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" autoComplete="off" value={value} disabled={busy} data-spec-path={path} aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-error` : undefined} onChange={(event) => onChange(event.currentTarget.value)} />
      {problem && <span id={`${id}-error`} className="region-error" role="alert">{problem}</span>}
    </div>;
  };

  const manifest = result?.manifest ?? null;
  return <section ref={root} aria-labelledby="region-title" className="region" data-region-state={state.phase}>
    <h2 id="region-title">Region edit</h2>
    <p>DEV_ONLY tracked region edit: a blur, pixelate or fill inside a mask that follows a track made by this host's local detector. The mask is the detector's box, not ground truth. Every change is a new version; your original is never changed. No quality, rights, approval or production claim.</p>
    <p role={state.phase === "failed" ? "alert" : "status"} aria-live="polite" aria-atomic="true" aria-busy={state.phase === "loading"} data-status-line>
      {state.phase === "loading" && "Reading the host's limits…"}
      {state.phase === "failed" && `${state.failure.code}: ${state.failure.text}`}
      {status && ready && `Region edits are available: up to ${status.maxFrames} frames, padding up to ${status.maxPaddingPx} pixels, effects ${status.effects.join(", ")}.`}
      {status && !ready && "Region edits are not available on this host."}
    </p>
    {state.phase === "failed" && <p><button type="button" onClick={() => void loadStatus()}>Retry reading limits</button></p>}

    <form onSubmit={(event) => void createLineage(event)} noValidate aria-labelledby="region-lineage-title">
      <h3 id="region-lineage-title">1. Lineage</h3>
      <p>A lineage is the history of one video. Naming a video makes it version 1.</p>
      {field("region-lineage-id", "Lineage id", lineageId, setLineageId, "$.lineageId")}
      {field("region-video-id", "Video artifact id", videoId, setVideoId, "$.artifactId")}
      {field("region-video-version", "Exact video version (sha256:…)", videoVersion, setVideoVersion, "$.artifactVersionId")}
      <p><button type="submit" disabled={busy || !ready}>Create lineage</button>{" "}
        <button type="button" disabled={busy || !ready} onClick={() => void openLineage(false)}>Load lineage</button></p>
    </form>
    <p role="status" aria-live="polite" aria-atomic="true" data-lineage-status>{message}</p>

    {lineage && <section aria-labelledby="region-versions-title" data-lineage-id={lineage.lineageId} data-head-version={lineage.headVersion}>
      <h3 id="region-versions-title">Versions of {lineage.lineageId}</h3>
      <div className="region-scroll" role="region" aria-label="Versions" tabIndex={0}><table data-version-table>
        <caption>Every version of the lineage; the head is the one the next edit builds on</caption>
        <thead><tr><th scope="col">Version</th><th scope="col">Kind</th><th scope="col">Derived from / restores</th><th scope="col">Content digest</th><th scope="col">Request</th></tr></thead>
        <tbody>{lineage.versions.map((version) => <tr key={version.versionNumber} data-version-number={version.versionNumber} data-version-kind={version.kind}
          data-head={version.versionNumber === lineage.headVersion ? "true" : undefined}>
          <th scope="row">{version.versionNumber}{version.versionNumber === lineage.headVersion ? " (head)" : ""}</th>
          <td>{version.kind}</td>
          <td>{version.kind === "BASE" ? "your video" : version.kind === "EDIT" ? `edit of version ${version.parentVersionNumber}` : `restores version ${version.restoresVersionNumber}`}</td>
          <td><code title={version.sha256}>{hex(version.sha256)}</code></td><td><code>{version.requestId}</code></td>
        </tr>)}</tbody>
      </table></div>
      <p><button type="button" disabled={busy || !ready || !lineage.undoAvailable} onClick={() => void submitUndo()}>Undo the last edit</button>{" "}
        <button type="button" disabled={busy || !ready} onClick={() => void openLineage(true)}>Reload lineage</button></p>
      {!lineage.undoAvailable && <p>Nothing to undo: the head is your original video.</p>}
    </section>}

    {lineage && <form onSubmit={(event) => void submitEdit(event)} noValidate aria-labelledby="region-edit-title" data-base-version={head ?? undefined}>
      <h3 id="region-edit-title">2. Edit the tracked region</h3>
      <p>This edit builds on version {head}. If the head moves before the host answers, you get a conflict and nothing is changed.</p>
      {field("region-tracks-id", "Tracks artifact id (from video tracking)", tracksId, setTracksId, "$.track.artifactId")}
      {field("region-tracks-version", "Exact tracks version (sha256:…)", tracksVersion, setTracksVersion, "$.track.artifactVersionId")}
      {field("region-track-id", "Track id", trackId, setTrackId, "$.track.trackId")}
      <div className="region-field">
        <label htmlFor="region-effect">Effect</label>
        <select id="region-effect" value={effect} disabled={busy} data-spec-path="$.effect.type" onChange={(event) => setEffect(event.currentTarget.value)}>
          {(status?.effects ?? ["BLUR", "PIXELATE", "FILL"]).map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </div>
      {effect === "PIXELATE" && field("region-block-size", "Block size (even, 2 to 64)", blockSize, setBlockSize, "$.effect.blockSize")}
      {effect === "BLUR" && field("region-radius", "Blur radius (1 to 32)", radius, setRadius, "$.effect.radius")}
      {effect === "FILL" && field("region-color", "Fill colour (#RRGGBB)", color, setColor, "$.effect.color")}
      {field("region-padding", `Padding around the mask (pixels, 0 to ${status?.maxPaddingPx ?? 64})`, padding, setPadding, "$.paddingPx")}
      {field("region-max-drift", "Refuse if the track's own drift exceeds (pixels, optional)", maxDrift, setMaxDrift, "$.maxDriftPx")}
      <div className="region-field">
        <label htmlFor="region-encoder">Encoder</label>
        <select id="region-encoder" value={encoder} disabled={busy} data-spec-path="$.encoder.crf" onChange={(event) => setEncoder(event.currentTarget.value)}>
          <option value="0">Lossless: samples outside the mask are bit-identical (large file)</option>
          <option value="18">Preview (CRF 18): plays in browsers, outside the mask within a reported PSNR</option>
        </select>
      </div>
      {problems.length > 0 && <ul role="alert" className="region-errors" data-problems>{problems.map((problem) =>
        <li key={problem.path}><code>{problem.path}</code> {problem.message}</li>)}</ul>}
      <p><button type="submit" disabled={busy || !ready} aria-busy={pending}>{pending ? "Working…" : "Apply edit"}</button></p>
    </form>}

    <p role="status" aria-live="polite" aria-atomic="true" data-region-status>
      {pending ? "Rendering and verifying. The result is shown only after the host verifies and registers it." : result ? "Registered." : "Nothing applied yet."}
    </p>

    {failure && <div role="alert" className="region-failure" data-failure-code={failure.code} data-failure-tone={failure.tone}
      {...(failure.path ? { "data-failure-path": failure.path } : {})}>
      <h3 ref={failureHeading} tabIndex={-1}>{TONE_HEADING[failure.tone]}</h3>
      <p><code>{failure.code}</code> {failure.text}</p>
      {failure.stale && <p data-stale>Sent against version {failure.stale.expected}; the head is version {failure.stale.head}.</p>}
      {(failure.stale || failure.code === "LINEAGE_NOT_FOUND") && lineage && <p><button type="button" onClick={() => void openLineage(true)} disabled={busy}>Reload lineage</button></p>}
    </div>}

    {result && <section aria-labelledby="region-result-title" className="region-result" data-region-result data-version-number={result.version.versionNumber}>
      <h3 id="region-result-title" ref={resultHeading} tabIndex={-1}>
        {result.version.kind === "UNDO" ? `Undo registered: version ${result.version.versionNumber}` : `Edit registered: version ${result.version.versionNumber}`}</h3>
      {result.version.kind === "UNDO" && <p data-undo-summary>
        The head now points at the exact artifact of version {result.version.restoresVersionNumber}: SHA-256 <code data-head-sha256>{result.version.sha256}</code>.</p>}
      {manifest && <>
        <p data-edit-summary>{result.replayed ? "Replayed: the same request identifier returned the stored version. " : ""}
          {manifest.effect} on {manifest.maskedFrames} of {manifest.frames.length} frames of {manifest.width} by {manifest.height}.</p>
        <dl>
          <dt>Verified by the host</dt>
          <dd data-verification>every frame time exact: {manifest.verification.ptsExact ? "yes" : "no"}; outside the mask {manifest.verification.outsideLossless ? "bit-identical (lossless)" : "within reported PSNR"}: largest sample difference {manifest.verification.outsideMaxAbsDiff}, PSNR {manifest.verification.outsidePsnrDb === "INFINITE" ? "infinite" : `${manifest.verification.outsidePsnrDb} dB`}; samples inside the mask changed: {manifest.verification.insideChangedSamples}</dd>
          <dt>Track drift (no ground truth)</dt>
          <dd data-drift>{manifest.drift.observations} observations, largest gap {manifest.drift.maxGapFrames} frames; leave-one-out centre error at most {manifest.drift.maxCenterErrorPx} px (mean {manifest.drift.meanCenterErrorPx}), lowest overlap {manifest.drift.minIou}</dd>
          <dt>Video</dt><dd><code>{result.version.artifactId}</code> <code>{result.version.artifactVersionId}</code> ({result.version.sizeBytes ?? "?"} bytes)</dd>
        </dl>
        <MaskedPlayback key={result.version.artifactVersionId} reader={regionEdit.readArtifactContent} version={result.version} manifest={manifest} locked={locked} />
        <details><summary>Per-frame masks ({manifest.frames.length} frames)</summary>
          <div className="region-scroll" role="region" aria-label="Per-frame masks" tabIndex={0}><table data-mask-table>
            <caption>Mask of every frame at its exact presentation time</caption>
            <thead><tr><th scope="col">Frame</th><th scope="col">Time (seconds)</th><th scope="col">Mask source</th><th scope="col">Mask x, y, width, height</th></tr></thead>
            <tbody>{manifest.frames.map((frame) => <tr key={frame.frameIndex} data-frame-index={frame.frameIndex}>
              <th scope="row">{frame.frameIndex}</th><td>{frame.seconds.toFixed(4)}</td><td>{frame.source}</td>
              <td>{frame.mask ? `${frame.mask.x}, ${frame.mask.y}, ${frame.mask.width}, ${frame.mask.height}` : "none"}</td>
            </tr>)}</tbody>
          </table></div>
        </details>
      </>}
    </section>}
  </section>;
}
