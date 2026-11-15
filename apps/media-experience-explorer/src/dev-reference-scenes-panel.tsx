import React from "react";
import { ReferenceScenesHostError } from "./dev-reference-scenes-client";
import type { ReferenceScenesPort } from "./dev-reference-scenes-client";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Mode = "TEMPLATE" | "MODEL";
type Template = "reference-stage" | "product-spotlight";

export interface ReadContent {
  (request: { artifactId: string; artifactVersionId: string; maxBytes: number }): Promise<{ status: number; contentType: string | null; bytes: Uint8Array }>;
}

interface RefRow { referenceId: string; artifactId: string; artifactVersionId: string }
interface SlotRow { referenceId: string; x: string; height: string; tintColor: string; tintStrength: string }
interface Failure { code: string; message: string; path?: string; details?: Json }

const MAX_SCENE_BYTES = 2 * 1024 * 1024;
const requestId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const describe = (error: unknown): Failure => {
  if (error instanceof ReferenceScenesHostError) {
    const path = typeof error.details?.path === "string" ? error.details.path : undefined;
    return { code: error.code, message: error.message, ...(path ? { path } : {}), ...(error.details ? { details: error.details as Json } : {}) };
  }
  return { code: "UNEXPECTED", message: error instanceof Error ? error.message : "Unexpected failure." };
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Moves focus to the input a host path names: the exact path, else its parents; a spotlight subject is slot 0. */
function focusPath(root: HTMLElement | null, path: string | undefined): boolean {
  if (!root || !path) return false;
  let candidate: string | null = path.replace(/^\$\.parameters\.subject/u, "$.parameters.slots[0]").replace(/^(\$\.references\[[0-9]+\])$/u, "$1.artifactId");
  while (candidate) {
    const node = Array.from(root.querySelectorAll<HTMLElement>("[data-path]")).find((element) => element.dataset.path === candidate);
    if (node) { node.focus(); return true; }
    const next: string = candidate.replace(/(\.[A-Za-z]+|\[[0-9]+\])$/u, "");
    candidate = next === candidate ? null : next;
  }
  return false;
}

export function ReferenceScenesPanel({ scenes, readContent }: { scenes: ReferenceScenesPort; readContent: ReadContent }): React.ReactElement {
  const root = React.useRef<HTMLDivElement>(null);
  const [status, setStatus] = React.useState<Json | null>(null);
  const [refs, setRefs] = React.useState<RefRow[]>([{ referenceId: "hero", artifactId: "", artifactVersionId: "" }]);
  const [set, setSet] = React.useState<Json | null>(null);
  const [mode, setMode] = React.useState<Mode>("TEMPLATE");
  const [template, setTemplate] = React.useState<Template>("reference-stage");
  const [seed, setSeed] = React.useState("20260101");
  const [sceneCount, setSceneCount] = React.useState("3");
  const [palette, setPalette] = React.useState("#101828, #1E293B, #38BDF8");
  const [slots, setSlots] = React.useState<SlotRow[]>([{ referenceId: "hero", x: "0.5", height: "0.5", tintColor: "", tintStrength: "" }]);
  const [drift, setDrift] = React.useState("4");
  const [sparkles, setSparkles] = React.useState("0");
  const [pushStart, setPushStart] = React.useState("0.9");
  const [pushEnd, setPushEnd] = React.useState("1.2");
  const [maxHistogram, setMaxHistogram] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<Failure | null>(null);
  const [announce, setAnnounce] = React.useState("");
  const [run, setRun] = React.useState<Json | null>(null);
  const [images, setImages] = React.useState<{ url: string; verified: boolean; index: number }[]>([]);
  const [proof, setProof] = React.useState<Json | null>(null);
  const lastSet = React.useRef<{ key: string; id: string } | null>(null);
  const lastRun = React.useRef<{ key: string; id: string } | null>(null);
  const resultHeading = React.useRef<HTMLHeadingElement>(null);
  const errorHeading = React.useRef<HTMLHeadingElement>(null);

  React.useEffect(() => { scenes.status().then((value) => setStatus(value as Json)).catch((error) => setFailure(describe(error))); }, [scenes]);
  React.useEffect(() => () => images.forEach((image) => URL.revokeObjectURL(image.url)), [images]);

  const reuse = (holder: React.MutableRefObject<{ key: string; id: string } | null>, key: string, prefix: string): string => {
    if (!holder.current || holder.current.key !== key) holder.current = { key, id: requestId(prefix) };
    return holder.current.id;
  };

  const fail = (error: unknown): void => {
    const described = describe(error);
    setFailure(described);
    setAnnounce(`${described.code}: ${described.message}`);
    window.setTimeout(() => { if (!focusPath(root.current, described.path)) errorHeading.current?.focus(); }, 0);
  };

  const registerSet = async (): Promise<void> => {
    setBusy(true); setFailure(null); setSet(null);
    const references = refs.map((row) => ({ referenceId: row.referenceId.trim(), artifactId: row.artifactId.trim(), artifactVersionId: row.artifactVersionId.trim() }));
    const key = JSON.stringify(references);
    try {
      const view = await scenes.registerSet({ requestId: reuse(lastSet, key, "refset"), name: "Explorer reference set", references }) as Json;
      setSet(view);
      setAnnounce(`Reference set registered${view.replayed ? " (replay)" : ""}. Every reference holds a processing rights statement.`);
    } catch (error) { fail(error); } finally { setBusy(false); }
  };

  const buildRequest = (): { body?: Json; errors: string[] } => {
    const errors: string[] = [];
    const whole = (value: string, label: string, path: string): number => {
      if (!/^-?[0-9]{1,18}$/u.test(value.trim())) { errors.push(`${label} must be a whole number.`); return Number.NaN; }
      return Number(value);
    };
    const decimal = (value: string, label: string): number => {
      const number = Number(value);
      if (value.trim() === "" || !Number.isFinite(number)) { errors.push(`${label} must be a number.`); return Number.NaN; }
      return number;
    };
    if (mode === "MODEL") return { body: { requestId: reuse(lastRun, "MODEL", "model"), mode: "MODEL", ...(set?.referenceSetId ? { referenceSetId: set.referenceSetId } : {}) }, errors };
    const slotBodies = slots.map((slot, i) => {
      const out: Json = { referenceId: slot.referenceId.trim(), height: decimal(slot.height, `Slot ${i + 1} height`) };
      if (template === "reference-stage") out.x = decimal(slot.x, `Slot ${i + 1} centre`);
      if (slot.tintColor.trim()) out.tint = { color: slot.tintColor.trim(), strength: decimal(slot.tintStrength || "0", `Slot ${i + 1} tint strength`) };
      return out;
    });
    const parameters: Json = {
      palette: palette.split(",").map((colour) => colour.trim()).filter((colour) => colour !== ""),
      ...(template === "product-spotlight" ? { subject: slotBodies[0] } : { slots: slotBodies }),
      drift: whole(drift, "Drift", "$.parameters.drift"),
      sparkles: whole(sparkles, "Sparkles", "$.parameters.sparkles"),
      push: { start: decimal(pushStart, "Push start"), end: decimal(pushEnd, "Push end") },
    };
    const body: Json = {
      mode: "TEMPLATE", referenceSetId: set?.referenceSetId ?? "", template: { id: template, version: 1 },
      seed: whole(seed, "Seed", "$.seed"), sceneCount: whole(sceneCount, "Scenes", "$.sceneCount"), parameters,
    };
    if (maxHistogram.trim()) body.continuity = { maxHistogramDistance: decimal(maxHistogram, "Histogram threshold") };
    if (errors.length) return { errors };
    body.requestId = reuse(lastRun, JSON.stringify(body), "scenes");
    return { body, errors };
  };

  const generate = async (): Promise<void> => {
    setFailure(null); setRun(null); setProof(null); setImages([]);
    const { body, errors } = buildRequest();
    if (!body) { setFailure({ code: "INPUT_INVALID", message: errors.join(" ") }); setAnnounce(errors.join(" ")); return; }
    setBusy(true);
    try {
      const view = await scenes.generate(body) as Json;
      setRun(view);
      setAnnounce(`${view.outcome}: ${view.scenes.length} scenes registered${view.replayed ? " (replay)" : ""}. Verifying each scene against its registered digest.`);
      const verified: { url: string; verified: boolean; index: number }[] = [];
      for (let index = 0; index < view.scenes.length; index += 1) {
        const scene = view.scenes[index] as Json;
        const content = await readContent({ artifactId: scene.artifactId, artifactVersionId: scene.artifactVersionId, maxBytes: MAX_SCENE_BYTES });
        const ok = (await sha256Hex(content.bytes)) === scene.sha256;
        if (ok) verified.push({ url: URL.createObjectURL(new Blob([content.bytes as unknown as ArrayBuffer], { type: "image/png" })), verified: true, index });
      }
      setImages(verified);
      window.setTimeout(() => resultHeading.current?.focus(), 0);
    } catch (error) { fail(error); } finally { setBusy(false); }
  };

  const regenerate = async (): Promise<void> => {
    if (!run) return;
    setBusy(true); setFailure(null);
    try {
      const result = await scenes.regenerate(run.runId) as Json;
      setProof(result);
      setAnnounce(result.byteIdentical ? "Regeneration is byte-identical to the stored scenes." : "Regeneration DIFFERS from the stored scenes.");
    } catch (error) { fail(error); } finally { setBusy(false); }
  };

  const updateRef = (index: number, patch: Partial<RefRow>): void => setRefs((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const updateSlot = (index: number, patch: Partial<SlotRow>): void => setSlots((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const metrics = run?.manifest?.scenes as Json[] | undefined;

  return (
    <div ref={root} className="refscenes">
      <p className="visually-hidden" role="status" aria-live="polite" id="refscenes-announce">{announce}</p>
      {status && (
        <section className="panel" aria-labelledby="rs-status">
          <h2 id="rs-status">Host capabilities</h2>
          <dl>
            <dt>Templates</dt><dd>{(status.templates as Json[]).map((t) => `${t.id} v${t.version}`).join(", ")}</dd>
            <dt>Generative model</dt><dd id="rs-model-state">{status.model.available ? "available" : `unavailable (${status.model.reason}); no fallback`}</dd>
            <dt>Rights authority</dt><dd>{status.rightsAuthority.resolverId} · {status.rightsAuthority.scope} · {status.rightsAuthority.appliesTo}</dd>
          </dl>
        </section>
      )}

      <section className="panel" aria-labelledby="rs-refs">
        <h2 id="rs-refs">1. Reference set</h2>
        <p>Name stored image versions by their exact artifact id and version. Each needs a processing rights statement; a missing or revoked one is refused and nothing is registered.</p>
        {refs.map((row, i) => (
          <fieldset key={i}>
            <legend>Reference {i + 1}</legend>
            <label>Reference name<input data-path={`$.references[${i}].referenceId`} value={row.referenceId} onChange={(e) => updateRef(i, { referenceId: e.target.value })} /></label>
            <label>Artifact id<input data-path={`$.references[${i}].artifactId`} value={row.artifactId} onChange={(e) => updateRef(i, { artifactId: e.target.value })} /></label>
            <label>Exact version (sha256:…)<input data-path={`$.references[${i}].artifactVersionId`} value={row.artifactVersionId} onChange={(e) => updateRef(i, { artifactVersionId: e.target.value })} /></label>
            {refs.length > 1 && <button type="button" onClick={() => setRefs((rows) => rows.filter((_, j) => j !== i))}>Remove reference {i + 1}</button>}
          </fieldset>
        ))}
        {refs.length < 6 && <button type="button" onClick={() => setRefs((rows) => [...rows, { referenceId: `ref${rows.length + 1}`, artifactId: "", artifactVersionId: "" }])}>Add reference</button>}
        <button type="button" id="rs-register" disabled={busy} onClick={() => void registerSet()}>Register reference set</button>
        {set && <p id="rs-set-result" role="status">Reference set <code>{set.referenceSetId}</code> holds {set.document.references.length} reference(s), each admitted for PROCESSING ({(set.document.references as Json[]).map((r) => `${r.referenceId} ${r.width}×${r.height}`).join(", ")}).{set.replayed ? " Replayed." : ""}</p>}
      </section>

      <section className="panel" aria-labelledby="rs-generate">
        <h2 id="rs-generate">2. Generate scenes</h2>
        <fieldset>
          <legend>Generator</legend>
          <label><input type="radio" name="mode" checked={mode === "TEMPLATE"} onChange={() => setMode("TEMPLATE")} /> Authored template (deterministic)</label>
          <label><input type="radio" name="mode" checked={mode === "MODEL"} onChange={() => setMode("MODEL")} /> Generative model (unavailable on this host)</label>
        </fieldset>
        {mode === "TEMPLATE" && (
          <>
            <label>Template<select data-path="$.template.id" value={template} onChange={(e) => setTemplate(e.target.value as Template)}><option value="reference-stage">reference-stage v1 (up to 3 references)</option><option value="product-spotlight">product-spotlight v1 (one reference)</option></select></label>
            <label>Seed<input data-path="$.seed" value={seed} onChange={(e) => setSeed(e.target.value)} /></label>
            <label>Scenes (1–8)<input data-path="$.sceneCount" value={sceneCount} onChange={(e) => setSceneCount(e.target.value)} /></label>
            <label>Palette (2–6 colours, #RRGGBB, comma separated)<input data-path="$.parameters.palette" value={palette} onChange={(e) => setPalette(e.target.value)} /></label>
            {slots.map((slot, i) => (
              <fieldset key={i}>
                <legend>{template === "product-spotlight" ? "Subject" : `Slot ${i + 1}`}</legend>
                <label>Reference name<input data-path={`$.parameters.slots[${i}].referenceId`} value={slot.referenceId} onChange={(e) => updateSlot(i, { referenceId: e.target.value })} /></label>
                {template === "reference-stage" && <label>Centre across the canvas (0.1–0.9)<input data-path={`$.parameters.slots[${i}].x`} value={slot.x} onChange={(e) => updateSlot(i, { x: e.target.value })} /></label>}
                <label>Height as a fraction of the canvas (0.1–0.8)<input data-path={`$.parameters.slots[${i}].height`} value={slot.height} onChange={(e) => updateSlot(i, { height: e.target.value })} /></label>
                <label>Recolour (#RRGGBB, optional)<input data-path={`$.parameters.slots[${i}].tint.color`} value={slot.tintColor} onChange={(e) => updateSlot(i, { tintColor: e.target.value })} /></label>
                <label>Recolour strength (0–1)<input data-path={`$.parameters.slots[${i}].tint.strength`} value={slot.tintStrength} onChange={(e) => updateSlot(i, { tintStrength: e.target.value })} /></label>
                {template === "reference-stage" && slots.length > 1 && <button type="button" onClick={() => setSlots((rows) => rows.filter((_, j) => j !== i))}>Remove slot {i + 1}</button>}
              </fieldset>
            ))}
            {template === "reference-stage" && slots.length < 3 && <button type="button" onClick={() => setSlots((rows) => [...rows, { referenceId: "", x: "0.8", height: "0.4", tintColor: "", tintStrength: "" }])}>Add slot</button>}
            <label>Drift in pixels (0–16)<input data-path="$.parameters.drift" value={drift} onChange={(e) => setDrift(e.target.value)} /></label>
            <label>Sparkles (0–64)<input data-path="$.parameters.sparkles" value={sparkles} onChange={(e) => setSparkles(e.target.value)} /></label>
            <label>Scale push, first scene<input data-path="$.parameters.push.start" value={pushStart} onChange={(e) => setPushStart(e.target.value)} /></label>
            <label>Scale push, last scene<input data-path="$.parameters.push.end" value={pushEnd} onChange={(e) => setPushEnd(e.target.value)} /></label>
            <label>Continuity: maximum histogram distance (optional, default 0.35)<input data-path="$.continuity.maxHistogramDistance" value={maxHistogram} onChange={(e) => setMaxHistogram(e.target.value)} /></label>
          </>
        )}
        <button type="button" id="rs-generate-button" disabled={busy || (mode === "TEMPLATE" && !set)} onClick={() => void generate()}>{mode === "MODEL" ? "Ask the model" : "Generate scenes"}</button>
        {mode === "TEMPLATE" && !set && <p className="hint">Register a reference set first.</p>}
      </section>

      {failure && (
        <section className="panel" role="alert" aria-labelledby="rs-error">
          <h2 id="rs-error" tabIndex={-1} ref={errorHeading}>Refused: {failure.code}</h2>
          <p id="rs-error-message">{failure.message}</p>
          {failure.path && <p>Path: <code>{failure.path}</code></p>}
          {failure.code === "MODEL_UNAVAILABLE" && <p id="rs-model-note">No scenes were created and no template was substituted.</p>}
          {failure.code === "CONTINUITY_THRESHOLD_FAILED" && Array.isArray(failure.details?.violations) && (
            <table>
              <caption>Failed continuity thresholds (nothing was registered)</caption>
              <thead><tr><th scope="col">Scene</th><th scope="col">Slot</th><th scope="col">Metric</th><th scope="col">Value</th><th scope="col">Limit</th></tr></thead>
              <tbody>{(failure.details.violations as Json[]).map((v, i) => <tr key={i}><td>{v.scene}</td><td>{v.slot ?? "scene"}</td><td>{v.metric}</td><td>{v.value}</td><td>{v.limit === "MAX" ? "≤" : "≥"} {v.threshold}</td></tr>)}</tbody>
            </table>
          )}
          {failure.details?.verdict && <p>Rights verdict: <strong>{String(failure.details.verdict)}</strong>. Nothing was generated.</p>}
        </section>
      )}

      {run && (
        <section className="panel" aria-labelledby="rs-result">
          <h2 id="rs-result" tabIndex={-1} ref={resultHeading}>Result: {run.outcome}</h2>
          <dl>
            <dt>Run</dt><dd><code id="rs-run-id">{run.runId}</code>{run.replayed ? " (replay)" : ""}</dd>
            <dt>Generator</dt><dd>{run.manifest.generator.kind} · {run.manifest.generator.templateId} v{run.manifest.generator.templateVersion} · seed {String(run.manifest.generator.seed)} · generative model used: {String(run.manifest.generator.generativeModelUsed)}</dd>
            <dt>References</dt><dd>{(run.manifest.references as Json[]).map((r) => `${r.assetId} ${r.artifactId}@${String(r.artifactVersionId).slice(0, 14)} (${r.rights.verdict})`).join("; ")}</dd>
            <dt>Worst measured</dt><dd>histogram {run.manifest.summary.maxHistogramDistance} · SSIM {run.manifest.summary.minSsim} · hash {run.manifest.summary.maxHashDistance} · cross-scene {run.manifest.summary.maxCrossSceneHistogramDistance} · palette {run.manifest.summary.minPaletteAdherence}</dd>
          </dl>
          <div className="refscenes-gallery">
            {images.map((image) => (
              <figure key={image.index}>
                <img src={image.url} alt={`Scene ${image.index + 1} composed from the reference set`} className="refscenes-image" data-scene={image.index} />
                <figcaption>Scene {image.index + 1} · SHA-256 matches the registered digest</figcaption>
              </figure>
            ))}
          </div>
          <div className="refscenes-scroll" tabIndex={0} role="region" aria-label="Continuity metrics table">
            <table id="rs-metrics">
              <caption>Continuity measured on the decoded output PNGs</caption>
              <thead><tr><th scope="col">Scene</th><th scope="col">Reference</th><th scope="col">Histogram distance</th><th scope="col">SSIM</th><th scope="col">Hash distance</th><th scope="col">Render max diff</th><th scope="col">Cross-scene histogram</th><th scope="col">Palette adherence</th></tr></thead>
              <tbody>
                {(metrics ?? []).flatMap((scene) => (scene.metrics.slots as Json[]).map((slot) => (
                  <tr key={`${scene.index}-${slot.slot}`}>
                    <td>{scene.index + 1}</td><td>{slot.referenceId}</td><td>{slot.histogramDistance}</td><td>{slot.ssim}</td><td>{slot.hashDistance}</td><td>{slot.renderMaxAbsDiff}</td>
                    <td>{slot.crossScene ? slot.crossScene.histogramDistance : "baseline"}</td><td>{scene.metrics.paletteAdherence}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
          <button type="button" id="rs-regenerate" disabled={busy} onClick={() => void regenerate()}>Regenerate and compare</button>
          {proof && <p id="rs-proof" role="status">{proof.byteIdentical ? "Byte-identical" : "DIFFERENT"}: {(proof.scenes as Json[]).length} scene(s) re-rendered from the stored manifest (rights re-checked, {proof.artifactsCreated} artifacts created).</p>}
        </section>
      )}
    </div>
  );
}
