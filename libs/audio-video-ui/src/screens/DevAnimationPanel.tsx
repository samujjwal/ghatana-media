import React from "react";
import {
  EASINGS, PRIMITIVES, blankKeyframe, blankShape, describeAnimationFailure, exampleSpec, parseAnimationRenderView, parseAnimationStatus,
  sampleCurve, toRequestSpec,
  type AnimationFailure, type AnimationRenderView, type AnimationStatus, type AuthoredAsset, type AuthoredKeyframe, type AuthoredShape,
  type AuthoredSpec, type DevAnimationPort,
} from "./devAnimation";
import { describeContentFailure, readVerifiedContent, type RegisteredArtifact } from "./devArtifactContent";

export interface DevAnimationPanelProps {
  readonly animation: DevAnimationPort;
  readonly locked?: boolean;
  /** Injectable for deterministic tests; must return a fresh opaque id per call. */
  readonly newRequestId?: () => string;
}

type StatusState =
  | { readonly phase: "loading" }
  | { readonly phase: "failed"; readonly failure: AnimationFailure }
  | { readonly phase: "loaded"; readonly status: AnimationStatus };

let counter = 0;
const defaultRequestId = (): string => {
  const random = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${(counter++).toString(36)}`;
  return `anim-${random}`;
};

const TONE_HEADING: Readonly<Record<AnimationFailure["tone"], string>> = {
  invalid: "Scene not valid", budget: "Over budget", denied: "Denied", notFound: "Not found", conflict: "Request conflict",
  unknown: "Outcome unknown", unavailable: "Unavailable",
};

type Playback = { readonly phase: "idle" } | { readonly phase: "loading" }
  | { readonly phase: "verified"; readonly url: string; readonly text: string } | { readonly phase: "failed"; readonly text: string };

/** Loads the MP4 through the verified-content reader: playback starts only after the registered SHA-256 matches. */
function VideoPlayback({ reader, video, locked, label }: {
  readonly reader: DevAnimationPort["readArtifactContent"]; readonly video: RegisteredArtifact; readonly locked: boolean; readonly label: string;
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
      const verified = await readVerifiedContent({ readArtifactContent: reader }, video);
      const url = URL.createObjectURL(new Blob([verified.bytes as BlobPart], { type: verified.contentType }));
      urls.current.push(url);
      if (alive.current) setState({ phase: "verified", url, text: `Bytes verified against the registered version: SHA-256 ${verified.sha256} (${verified.bytes.byteLength} bytes).` });
    } catch (error) {
      const shown = describeContentFailure(error);
      if (alive.current) setState({ phase: "failed", text: `${shown.code}: ${shown.text}` });
    }
  };
  return <section aria-label="Rendered video playback" data-playback-state={state.phase}>
    {!reader && <p role="note">This host exposes no DEV_ONLY content route to this page, so the video cannot be played here.</p>}
    {reader && <p><button type="button" onClick={() => void load()} disabled={locked || state.phase === "loading" || state.phase === "verified"}>
      Load the video (verify bytes first)</button></p>}
    <p role={state.phase === "failed" ? "alert" : "status"} aria-live="polite" aria-atomic="true" aria-busy={state.phase === "loading"} data-playback-status>
      {state.phase === "idle" && "Video not loaded."}
      {state.phase === "loading" && "Reading the video and verifying its SHA-256…"}
      {(state.phase === "verified" || state.phase === "failed") && state.text}
    </p>
    {state.phase === "verified" && <video controls preload="metadata" muted playsInline src={state.url} data-verified-preview="animation-video" aria-label={label} />}
  </section>;
}

/** Approximate in-browser preview of the authored curves; the host's render is the only result. */
function PreviewCanvas({ authored, frame }: { readonly authored: AuthoredSpec; readonly frame: number }): React.ReactElement {
  const ref = React.useRef<HTMLCanvasElement | null>(null);
  const width = Math.min(1280, Math.max(16, Math.round(Number(authored.width)) || 320));
  const height = Math.min(720, Math.max(16, Math.round(Number(authored.height)) || 180));
  const lines: string[] = [];
  React.useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.fillStyle = /^#[0-9a-fA-F]{6}$/u.test(authored.background) ? authored.background : "#000000";
    context.fillRect(0, 0, width, height);
    for (const shape of authored.shapes) {
      const sample = sampleCurve(shape.keyframes, frame);
      const [x, y, w, h] = [Number(shape.x), Number(shape.y), Number(shape.width), Number(shape.height)];
      if (!sample || ![x, y, w, h].every(Number.isFinite)) continue;
      context.save();
      context.globalAlpha = Math.min(1, Math.max(0, sample.opacity));
      context.translate(x + w / 2 + sample.x, y + h / 2 + sample.y);
      context.scale(sample.scaleX, sample.scaleY);
      context.translate(-w / 2, -h / 2);
      context.fillStyle = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/u.test(shape.color) ? shape.color : "#ffffff";
      context.strokeStyle = context.fillStyle;
      if (shape.primitive === "ELLIPSE") { context.beginPath(); context.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); context.fill(); }
      else if (shape.primitive === "LINE") { context.beginPath(); context.moveTo(0, 0); context.lineTo(w, h); context.stroke(); }
      else if (shape.primitive === "RASTER_ASSET") { context.strokeStyle = "#ffffff"; context.strokeRect(0, 0, w, h); }
      else context.fillRect(0, 0, w, h);
      context.restore();
    }
  });
  for (const shape of authored.shapes) {
    const sample = sampleCurve(shape.keyframes, frame);
    lines.push(sample
      ? `${shape.id || "(no id)"}: offset ${sample.x.toFixed(2)}, ${sample.y.toFixed(2)}; scale ${sample.scaleX.toFixed(2)} by ${sample.scaleY.toFixed(2)}; opacity ${sample.opacity.toFixed(2)}`
      : `${shape.id || "(no id)"}: a keyframe value is not a number`);
  }
  return <div data-preview>
    <canvas ref={ref} width={width} height={height} role="img" aria-label={`Approximate preview of frame ${frame}`} className="animation-canvas" />
    <ul data-preview-description aria-label={`Shape positions at preview frame ${frame}`}>{lines.map((line) => <li key={line}>{line}</li>)}</ul>
  </div>;
}

const setAt = <T,>(list: readonly T[], index: number, value: T): T[] => list.map((entry, i) => (i === index ? value : entry));

/**
 * DEV_ONLY deterministic 2D animation: author a keyframed scene (shapes with four easing curves and optional image assets), preview
 * the curves approximately in the browser, and submit it to the host. The result is shown only after the host registers the MP4
 * and its frame manifest; the video plays only after its registered SHA-256 matches. No text primitive (host fonts would break
 * determinism). An image asset needs a processing rights statement; the page never states rights.
 */
export function DevAnimationPanel({ animation, locked = false, newRequestId = defaultRequestId }: DevAnimationPanelProps): React.ReactElement {
  const [state, setState] = React.useState<StatusState>({ phase: "loading" });
  const [authored, setAuthored] = React.useState<AuthoredSpec>(exampleSpec);
  const [crf, setCrf] = React.useState("14");
  const [previewFrame, setPreviewFrame] = React.useState(0);
  const [pending, setPending] = React.useState(false);
  const [failure, setFailure] = React.useState<AnimationFailure | null>(null);
  const [problems, setProblems] = React.useState<readonly { readonly path: string; readonly message: string }[]>([]);
  const [result, setResult] = React.useState<AnimationRenderView | null>(null);
  const attempt = React.useRef<{ readonly fingerprint: string; readonly requestId: string } | null>(null);
  const resultHeading = React.useRef<HTMLHeadingElement | null>(null);
  const failureHeading = React.useRef<HTMLHeadingElement | null>(null);
  const root = React.useRef<HTMLElement | null>(null);
  const alive = React.useRef(true);

  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const loadStatus = React.useCallback(async (): Promise<void> => {
    setState({ phase: "loading" });
    try {
      const status = parseAnimationStatus(await animation.getStatus());
      if (alive.current) { setState({ phase: "loaded", status }); setCrf(String(status.defaultCrf)); }
    } catch (error) {
      if (alive.current) setState({ phase: "failed", failure: describeAnimationFailure(error) });
    }
  }, [animation]);
  React.useEffect(() => { void loadStatus(); }, [loadStatus]);
  React.useEffect(() => { if (result) resultHeading.current?.focus(); }, [result?.renderId]);
  // Focus the offending field (or the failure heading) once the form is enabled again, so the focus call is not lost to a disabled fieldset.
  React.useEffect(() => { if (failure && !pending) focusPath(failure.path); }, [failure, pending]);

  const status = state.phase === "loaded" ? state.status : null;
  const ready = !!status && status.ready;
  const busy = locked || pending;
  const frameCount = Math.max(1, Math.min(240, Math.round(Number(authored.frameCount)) || 1));
  const patch = (change: Partial<AuthoredSpec>): void => { setAuthored({ ...authored, ...change }); setProblems([]); };
  const patchShape = (index: number, change: Partial<AuthoredShape>): void =>
    patch({ shapes: setAt(authored.shapes, index, { ...authored.shapes[index]!, ...change }) });
  const patchKey = (shape: number, key: number, change: Partial<AuthoredKeyframe>): void =>
    patchShape(shape, { keyframes: setAt(authored.shapes[shape]!.keyframes, key, { ...authored.shapes[shape]!.keyframes[key]!, ...change }) });
  const patchAsset = (index: number, change: Partial<AuthoredAsset>): void =>
    patch({ assets: setAt(authored.assets, index, { ...authored.assets[index]!, ...change }) });

  const focusPath = (path: string | null): void => {
    const target = path ? Array.from(root.current?.querySelectorAll<HTMLElement>("[data-spec-path]") ?? [])
      .find((element) => element.getAttribute("data-spec-path") === path) : undefined;
    (target ?? failureHeading.current)?.focus();
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || !ready) return;
    const built = toRequestSpec(authored);
    const crfValue = Number(crf);
    const all = [...built.problems, ...(Number.isInteger(crfValue) ? [] : [{ path: "$.encoder.crf", message: "Enter a whole number." }])];
    setProblems(all);
    if (all.length > 0) { setFailure(null); focusPath(all[0]!.path); return; }
    const request = { spec: built.spec, encoder: { crf: crfValue } };
    const fingerprint = JSON.stringify(request);
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, requestId: newRequestId() };
    setPending(true); setFailure(null);
    try {
      const view = parseAnimationRenderView(await animation.render({ requestId: attempt.current.requestId, ...request }));
      if (alive.current) setResult(view);
    } catch (error) {
      const shown = describeAnimationFailure(error);
      if (alive.current) { setFailure(shown); setResult(null); }
    } finally { if (alive.current) setPending(false); }
  };

  const problemFor = (path: string): string | undefined => problems.find((problem) => problem.path === path)?.message;
  const field = (id: string, label: string, value: string, onChange: (value: string) => void, path: string, extra: Record<string, unknown> = {}): React.ReactElement => {
    const message = problemFor(path);
    return <div className="animation-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" autoComplete="off" value={value} disabled={busy} data-spec-path={path} aria-invalid={message ? true : undefined}
        aria-describedby={message ? `${id}-error` : undefined} onChange={(event) => onChange(event.currentTarget.value)} {...extra} />
      {message && <span id={`${id}-error`} className="animation-error" role="alert">{message}</span>}
    </div>;
  };

  return <section ref={root} aria-labelledby="animation-title" className="animation" data-animation-state={state.phase}>
    <h2 id="animation-title">2D animation</h2>
    <p className="animation-scope">DEV_ONLY deterministic 2D render: the same scene always produces the same frames. The video is a lossy H.264 encode of them. No text primitive, no quality, rights, approval or production claim.</p>

    <p role={state.phase === "failed" ? "alert" : "status"} aria-live="polite" aria-atomic="true" aria-busy={state.phase === "loading"} data-status-line>
      {state.phase === "loading" && "Reading the host's limits…"}
      {state.phase === "failed" && `${state.failure.code}: ${state.failure.text}`}
      {status && ready && `The host renders up to ${status.maxWidth} by ${status.maxHeight} pixels, ${status.maxFrames} frames and ${status.maxFramesPerSecond} frames per second.`}
      {status && !ready && "Rendering is not available on this host."}
    </p>
    {state.phase === "failed" && <p><button type="button" onClick={() => void loadStatus()}>Retry reading limits</button></p>}

    <form onSubmit={(event) => void submit(event)} noValidate aria-describedby="animation-help">
      <p id="animation-help">Author the scene, then render. Shapes move by keyframes; each keyframe's easing shapes the motion to the next keyframe. Offsets are pixels from the shape's own position.</p>
      <p><button type="button" disabled={busy} onClick={() => { setAuthored(exampleSpec()); setProblems([]); setPreviewFrame(0); }}>Load the example scene</button></p>

      <fieldset disabled={busy}><legend>Canvas</legend>
        {field("animation-width", "Width (pixels, even)", authored.width, (value) => patch({ width: value }), "$.width")}
        {field("animation-height", "Height (pixels, even)", authored.height, (value) => patch({ height: value }), "$.height")}
        {field("animation-background", "Background (#RRGGBB)", authored.background, (value) => patch({ background: value }), "$.background")}
        {field("animation-fps-numerator", "Frames per second, numerator", authored.fpsNumerator, (value) => patch({ fpsNumerator: value }), "$.fps.numerator")}
        {field("animation-fps-denominator", "Frames per second, denominator", authored.fpsDenominator, (value) => patch({ fpsDenominator: value }), "$.fps.denominator")}
        {field("animation-frame-count", "Frame count", authored.frameCount, (value) => patch({ frameCount: value }), "$.frameCount")}
        {field("animation-crf", `Encoder quality (CRF ${status?.minCrf ?? 10} to ${status?.maxCrf ?? 30}, lower is better)`, crf, setCrf, "$.encoder.crf")}
      </fieldset>

      {authored.shapes.map((shape, s) => {
        const base = `$.shapes[${s}]`;
        return <fieldset key={s} disabled={busy} data-shape-index={s}><legend>Shape {s + 1}{shape.id ? `: ${shape.id}` : ""}</legend>
          {field(`animation-shape-${s}-id`, "Id", shape.id, (value) => patchShape(s, { id: value }), `${base}.id`)}
          <div className="animation-field">
            <label htmlFor={`animation-shape-${s}-primitive`}>Primitive</label>
            <select id={`animation-shape-${s}-primitive`} value={shape.primitive} data-spec-path={`${base}.primitive`}
              onChange={(event) => patchShape(s, { primitive: event.currentTarget.value as AuthoredShape["primitive"] })}>
              {(status?.primitives ?? PRIMITIVES).map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          {field(`animation-shape-${s}-x`, "X", shape.x, (value) => patchShape(s, { x: value }), `${base}.x`)}
          {field(`animation-shape-${s}-y`, "Y", shape.y, (value) => patchShape(s, { y: value }), `${base}.y`)}
          {field(`animation-shape-${s}-width`, "Width", shape.width, (value) => patchShape(s, { width: value }), `${base}.width`)}
          {field(`animation-shape-${s}-height`, "Height", shape.height, (value) => patchShape(s, { height: value }), `${base}.height`)}
          {shape.primitive === "RASTER_ASSET"
            ? field(`animation-shape-${s}-asset`, "Asset id (declared below)", shape.assetId, (value) => patchShape(s, { assetId: value }), `${base}.assetId`)
            : field(`animation-shape-${s}-color`, "Colour (#RRGGBB)", shape.color, (value) => patchShape(s, { color: value }), `${base}.color`)}
          <h3>Keyframes of shape {s + 1}</h3>
          {shape.keyframes.length === 0 && <p>No keyframes: the shape stays where it is.</p>}
          {shape.keyframes.map((key, k) => {
            const path = `${base}.keyframes[${k}]`;
            return <fieldset key={k} disabled={busy} data-keyframe-index={k}><legend>Keyframe {k + 1} of shape {s + 1}</legend>
              {field(`animation-shape-${s}-key-${k}-frame`, "Frame", key.frame, (value) => patchKey(s, k, { frame: value }), `${path}.frame`)}
              {field(`animation-shape-${s}-key-${k}-x`, "Offset X", key.x, (value) => patchKey(s, k, { x: value }), `${path}.x`)}
              {field(`animation-shape-${s}-key-${k}-y`, "Offset Y", key.y, (value) => patchKey(s, k, { y: value }), `${path}.y`)}
              {field(`animation-shape-${s}-key-${k}-sx`, "Scale X", key.scaleX, (value) => patchKey(s, k, { scaleX: value }), `${path}.scaleX`)}
              {field(`animation-shape-${s}-key-${k}-sy`, "Scale Y", key.scaleY, (value) => patchKey(s, k, { scaleY: value }), `${path}.scaleY`)}
              {field(`animation-shape-${s}-key-${k}-opacity`, "Opacity (0 to 1)", key.opacity, (value) => patchKey(s, k, { opacity: value }), `${path}.opacity`)}
              <div className="animation-field">
                <label htmlFor={`animation-shape-${s}-key-${k}-easing`}>Easing to the next keyframe</label>
                <select id={`animation-shape-${s}-key-${k}-easing`} value={key.easing} data-spec-path={`${path}.easing`}
                  onChange={(event) => patchKey(s, k, { easing: event.currentTarget.value as AuthoredKeyframe["easing"] })}>
                  {(status?.easings ?? EASINGS).map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
              <button type="button" onClick={() => patchShape(s, { keyframes: authored.shapes[s]!.keyframes.filter((_, i) => i !== k) })}>
                Remove keyframe {k + 1} of shape {s + 1}</button>
            </fieldset>;
          })}
          <p>
            <button type="button" onClick={() => patchShape(s, { keyframes: [...shape.keyframes, blankKeyframe(Math.min(frameCount - 1, Number(shape.keyframes.at(-1)?.frame ?? -1) + 1 || 0))] })}>
              Add a keyframe to shape {s + 1}</button>{" "}
            <button type="button" onClick={() => patch({ shapes: authored.shapes.filter((_, i) => i !== s) })}>Remove shape {s + 1}</button>
          </p>
        </fieldset>;
      })}
      <p><button type="button" disabled={busy} onClick={() => patch({ shapes: [...authored.shapes, blankShape(authored.shapes.length + 1)] })}>Add a shape</button></p>

      <fieldset disabled={busy}><legend>Image assets (optional)</legend>
        <p>Each asset is an exact image artifact version. It must carry a processing rights statement made by its uploader; this page never states rights.</p>
        {authored.assets.map((asset, a) => <fieldset key={a} disabled={busy}><legend>Asset {a + 1}</legend>
          {field(`animation-asset-${a}-id`, "Asset id", asset.id, (value) => patchAsset(a, { id: value }), `$.assets[${a}].id`)}
          {field(`animation-asset-${a}-artifact`, "Image artifact id", asset.artifactId, (value) => patchAsset(a, { artifactId: value }), `$.assets[${a}].artifactId`)}
          {field(`animation-asset-${a}-version`, "Exact version (sha256:…)", asset.artifactVersionId, (value) => patchAsset(a, { artifactVersionId: value }), `$.assets[${a}].artifactVersionId`)}
          <button type="button" onClick={() => patch({ assets: authored.assets.filter((_, i) => i !== a) })}>Remove asset {a + 1}</button>
        </fieldset>)}
        <button type="button" onClick={() => patch({ assets: [...authored.assets, { id: `asset-${authored.assets.length + 1}`, artifactId: "", artifactVersionId: "" }] })}>Add an image asset</button>
      </fieldset>

      <section aria-labelledby="animation-preview-title"><h3 id="animation-preview-title">Preview</h3>
        <p>An approximate preview of your curves in this browser. The host's render is the only result.</p>
        <div className="animation-field">
          <label htmlFor="animation-preview-frame">Preview frame: {previewFrame} of {frameCount - 1}</label>
          <input id="animation-preview-frame" type="range" min={0} max={frameCount - 1} step={1} value={Math.min(previewFrame, frameCount - 1)}
            onChange={(event) => setPreviewFrame(Number(event.currentTarget.value))} />
        </div>
        <PreviewCanvas authored={authored} frame={Math.min(previewFrame, frameCount - 1)} />
      </section>

      {problems.length > 0 && <ul role="alert" className="animation-errors" data-problems>{problems.map((problem) =>
        <li key={problem.path}><code>{problem.path}</code> {problem.message}</li>)}</ul>}
      <p><button type="submit" disabled={busy || !ready} aria-busy={pending}>{pending ? "Rendering…" : "Render"}</button></p>
    </form>

    <p role="status" aria-live="polite" aria-atomic="true" data-render-status>
      {pending ? "Rendering and encoding. The result is shown only after the host verifies and registers it." : result ? "Render registered." : "Nothing rendered yet."}
    </p>

    {failure && <div role="alert" className="animation-failure" data-failure-code={failure.code} data-failure-tone={failure.tone}
      {...(failure.path ? { "data-failure-path": failure.path } : {})}>
      <h3 ref={failureHeading} tabIndex={-1}>{TONE_HEADING[failure.tone]}</h3>
      <p><code>{failure.code}</code> {failure.text}</p>
    </div>}

    {result && <section aria-labelledby="animation-result-title" className="animation-result" data-render-result data-render-id={result.renderId}>
      <h3 id="animation-result-title" ref={resultHeading} tabIndex={-1}>Render result</h3>
      <p data-render-summary>
        {result.frameCount} frames of {result.width} by {result.height} at {result.fpsNumerator}/{result.fpsDenominator} frames per second, H.264 {result.verification.pixelFormat}.
        {result.replayed ? " Replayed: the same request identifier returned the stored render." : " Created."}
      </p>
      <dl>
        <dt>Verified by the host</dt><dd data-verification>{result.verification.codec}, average frame rate {result.verification.averageFrameRate}, time base {result.verification.timeBase}, every frame time exact: {result.verification.ptsExact ? "yes" : "no"}</dd>
        <dt>Frame set digest</dt><dd><code data-frame-set-sha256>{result.frameSetSha256}</code></dd>
        <dt>Video</dt><dd><code>{result.video.artifactId}</code> <code>{result.video.artifactVersionId}</code> ({result.video.sizeBytes ?? "?"} bytes)</dd>
        <dt>Manifest</dt><dd><code>{result.manifestArtifact.artifactId}</code></dd>
        <dt>Image assets</dt><dd>{result.assetCount}</dd>
      </dl>
      <VideoPlayback key={result.video.artifactVersionId} reader={animation.readArtifactContent} video={result.video} locked={locked}
        label={`Rendered animation ${result.video.artifactId}`} />
      <details><summary>Frame manifest ({result.frames.length} frames)</summary>
        <div className="animation-scroll" role="region" aria-label="Frame manifest" tabIndex={0}><table data-frame-table>
          <caption>Exact presentation time and digests of every rendered frame (before encoding)</caption>
          <thead><tr><th scope="col">Frame</th><th scope="col">Time (seconds)</th><th scope="col">Ticks</th><th scope="col">Pixel digest</th></tr></thead>
          <tbody>{result.frames.map((frame) => <tr key={frame.index} data-frame-index={frame.index}>
            <th scope="row">{frame.index}</th><td>{frame.ptsNumerator}/{frame.ptsDenominator}</td><td>{frame.ptsTicks}</td><td><code>{frame.pixelSha256.slice(0, 16)}…</code></td>
          </tr>)}</tbody>
        </table></div>
      </details>
    </section>}
  </section>;
}
