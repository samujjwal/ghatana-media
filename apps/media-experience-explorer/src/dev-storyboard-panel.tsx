import React from "react";
import { DevVerifiedContent } from "@audio-video/ui/screens";
import type { DevArtifactContentRequest, DevArtifactContentResponse } from "@audio-video/ui/screens";
import { StoryboardHostError } from "./dev-storyboard-client";
import type { StoryboardPort } from "./dev-storyboard-client";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Kind = "ANIMATION" | "ASSET" | "PLACEHOLDER";

interface ShotDraft { shotId: string; durationMs: string; kind: Kind; artifactId: string; artifactVersionId: string; sourceInMs: string; note: string; spec: string }
interface SceneDraft { sceneId: string; title: string; narrationId: string; narrationVersion: string; shots: ShotDraft[] }
interface Draft { title: string; text: string; width: string; height: string; fps: string; captionsId: string; captionsVersion: string; scenes: SceneDraft[] }

const KINDS: readonly Kind[] = ["ANIMATION", "ASSET", "PLACEHOLDER"];
const DEFAULT_SPEC = JSON.stringify({ background: "#102030", shapes: [] }, null, 1);

const blankShot = (n: number): ShotDraft => ({ shotId: `shot-${n}`, durationMs: "1000", kind: "PLACEHOLDER", artifactId: "", artifactVersionId: "", sourceInMs: "0", note: "", spec: DEFAULT_SPEC });
const blankScene = (n: number): SceneDraft => ({ sceneId: `scene-${n}`, title: `Scene ${n}`, narrationId: "", narrationVersion: "", shots: [blankShot(n * 10 + 1)] });
const emptyDraft: Draft = { title: "", text: "", width: "320", height: "240", fps: "25", captionsId: "", captionsVersion: "", scenes: [] };

function viewToDraft(view: Json): Draft {
  return {
    title: String(view.brief?.title ?? ""), text: String(view.brief?.text ?? ""),
    width: String(view.format?.width ?? 320), height: String(view.format?.height ?? 240), fps: String(view.format?.fps ?? 25),
    captionsId: String(view.captions?.artifactId ?? ""), captionsVersion: String(view.captions?.artifactVersionId ?? ""),
    scenes: (view.scenes ?? []).map((scene: Json): SceneDraft => ({
      sceneId: scene.sceneId, title: scene.title, narrationId: String(scene.narration?.artifactId ?? ""),
      narrationVersion: String(scene.narration?.artifactVersionId ?? ""),
      shots: (scene.shots ?? []).map((shot: Json): ShotDraft => ({
        shotId: shot.shotId, durationMs: String(shot.durationMs), kind: shot.source.kind,
        artifactId: String(shot.source.artifactId ?? ""), artifactVersionId: String(shot.source.artifactVersionId ?? ""),
        sourceInMs: String(shot.source.sourceInMs ?? 0), note: String(shot.source.note ?? ""),
        spec: JSON.stringify(shot.source.spec ?? { background: "#102030", shapes: [] }, null, 1),
      })),
    })),
  };
}

/** Client-side shape errors only name the scene and shot; the host remains the authority and returns the JSON path. */
function draftToBody(draft: Draft): { body?: Json; errors: string[] } {
  const errors: string[] = [];
  const whole = (value: string, label: string): number => {
    if (!/^(0|[1-9][0-9]{0,8})$/u.test(value.trim())) { errors.push(`${label} must be a whole number.`); return 0; }
    return Number(value);
  };
  const scenes = draft.scenes.map((scene, i) => {
    const out: Json = { sceneId: scene.sceneId.trim(), title: scene.title };
    if (scene.narrationId.trim()) out.narration = { artifactId: scene.narrationId.trim(), artifactVersionId: scene.narrationVersion.trim() };
    out.shots = scene.shots.map((shot, j) => {
      const label = `Scene ${i + 1} shot ${j + 1}`;
      const source: Json = { kind: shot.kind };
      if (shot.kind === "ASSET") {
        source.artifactId = shot.artifactId.trim(); source.artifactVersionId = shot.artifactVersionId.trim();
        source.sourceInMs = whole(shot.sourceInMs, `${label} asset start`);
      } else if (shot.kind === "PLACEHOLDER") {
        source.note = shot.note;
      } else {
        try { source.spec = JSON.parse(shot.spec); } catch { errors.push(`${label}: the animation spec is not valid JSON.`); }
      }
      return { shotId: shot.shotId.trim(), durationMs: whole(shot.durationMs, `${label} duration`), source };
    });
    return out;
  });
  const body: Json = {
    brief: { title: draft.title, text: draft.text },
    format: { width: whole(draft.width, "Width"), height: whole(draft.height, "Height"), fps: whole(draft.fps, "Frames per second") },
    scenes,
  };
  if (draft.captionsId.trim()) body.captions = { artifactId: draft.captionsId.trim(), artifactVersionId: draft.captionsVersion.trim() };
  return errors.length ? { errors } : { body, errors };
}

const describe = (error: unknown): { code: string; message: string; path?: string; blockers?: Json[] } => {
  if (error instanceof StoryboardHostError) {
    const path = typeof error.details?.path === "string" ? error.details.path : undefined;
    const blockers = Array.isArray(error.details?.blockers) ? error.details.blockers as Json[] : undefined;
    return { code: error.code, message: error.message, ...(path ? { path } : {}), ...(blockers ? { blockers } : {}) };
  }
  return { code: "UNEXPECTED", message: error instanceof Error ? error.message : "Unexpected failure." };
};

export interface StoryboardPanelProps {
  readonly port: StoryboardPort;
  readonly readContent: (request: DevArtifactContentRequest) => Promise<DevArtifactContentResponse>;
}

export function StoryboardPanel({ port, readContent }: StoryboardPanelProps): React.ReactElement {
  const [capabilities, setCapabilities] = React.useState<Json | null>(null);
  const [briefTitle, setBriefTitle] = React.useState("");
  const [briefText, setBriefText] = React.useState("");
  const [draft, setDraft] = React.useState<Draft>(emptyDraft);
  const [storyboardId, setStoryboardId] = React.useState("");
  const [view, setView] = React.useState<Json | null>(null);
  const [readiness, setReadiness] = React.useState<Json | null>(null);
  const [render, setRender] = React.useState<Json | null>(null);
  const [review, setReview] = React.useState<Json | null>(null);
  const [status, setStatus] = React.useState("Write a brief to start a storyboard.");
  const [failure, setFailure] = React.useState<ReturnType<typeof describe> | null>(null);
  const [formErrors, setFormErrors] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [basis, setBasis] = React.useState("");
  const [confirmed, setConfirmed] = React.useState(false);
  const pending = React.useRef<Record<string, string>>({});
  const requestId = (key: string): string => (pending.current[key] ??= `ui-${key}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const settle = (key: string, error?: unknown): void => {
    if (!(error instanceof StoryboardHostError) || error.code !== "OUTCOME_UNKNOWN") delete pending.current[key];
  };

  React.useEffect(() => { port.capabilities().then((value) => setCapabilities(value as Json)).catch((error) => setFailure(describe(error))); }, [port]);

  const isHead = view ? view.head === true : false;

  const refresh = async (id: string, versionNumber?: number): Promise<void> => {
    const loaded = (versionNumber === undefined ? await port.head(id) : await port.version(id, versionNumber)) as Json;
    setView(loaded);
    setDraft(viewToDraft(loaded));
    setStoryboardId(id);
    setReadiness(await port.readiness(id) as Json);
    setRender(await port.renderOf(id, loaded.versionNumber).catch(() => null) as Json | null);
    setReview(await port.reviewStatus(id, loaded.versionNumber).catch(() => null) as Json | null);
  };

  const run = async (key: string, label: string, action: () => Promise<void>): Promise<void> => {
    setBusy(true); setFailure(null); setFormErrors([]); setStatus(`${label}…`);
    try { await action(); settle(key); } catch (error) {
      settle(key, error);
      const shown = describe(error);
      setFailure(shown);
      setStatus(`${label} failed: ${shown.code}${shown.path ? ` at ${shown.path}` : ""}.`);
    } finally { setBusy(false); }
  };

  const createFromBrief = (event: React.FormEvent): void => {
    event.preventDefault();
    void run("create", "Creating the storyboard", async () => {
      const created = await port.create({ requestId: requestId("create"), brief: { title: briefTitle, text: briefText } }) as Json;
      await refresh(created.storyboardId);
      setStatus(`Storyboard ${created.storyboardId} version ${created.versionNumber} created from the brief. Placeholder shots cannot render.`);
    });
  };

  const save = (): void => {
    const converted = draftToBody(draft);
    if (!converted.body) { setFormErrors(converted.errors); setStatus("The storyboard was not saved: fix the listed fields."); return; }
    void run("edit", "Saving a new version", async () => {
      const saved = await port.edit(storyboardId, { requestId: requestId("edit"), expectedVersion: view?.versionNumber, ...converted.body }) as Json;
      await refresh(storyboardId);
      setStatus(`Saved version ${saved.versionNumber}. Render and review state were re-derived.`);
    });
  };

  const doRender = (): void => {
    void run("render", "Rendering", async () => {
      const result = await port.render(storyboardId, requestId("render"), view?.versionNumber) as Json;
      setRender(result);
      await refresh(storyboardId, result.storyboardVersion);
      setStatus(`Rendered storyboard version ${result.storyboardVersion}: ${result.lineage?.frameCount} frames.`);
    });
  };

  const openReview = (): void => {
    void run("review", "Opening the review", async () => {
      const opened = await port.openReview(storyboardId, view?.versionNumber) as Json;
      setReview(opened);
      setStatus(`Review case ${opened.review?.reviewCaseId} is open for this exact render.`);
    });
  };

  const refreshReview = (): void => {
    void run("review-status", "Reading the review state", async () => {
      setReview(await port.reviewStatus(storyboardId, view?.versionNumber) as Json);
      setStatus("Review state refreshed from the host.");
    });
  };

  const attest = (event: React.FormEvent): void => {
    event.preventDefault();
    void run("attest", "Recording the rights statement", async () => {
      await port.attest({ artifactId: view?.artifact.artifactId, artifactVersionId: view?.artifact.artifactVersionId, statementKind: "MEDIA_RIGHTS",
        scopes: ["PROCESSING"], basis });
      await refresh(storyboardId, view?.versionNumber);
      setStatus("Your statement about this exact storyboard version was recorded; readiness was re-derived.");
    });
  };

  const update = (change: (next: Draft) => void): void => { const next = structuredClone(draft); change(next); setDraft(next); };
  const move = <T,>(list: T[], index: number, delta: number): void => { const target = index + delta; if (target < 0 || target >= list.length) return; [list[index], list[target]] = [list[target]!, list[index]!]; };
  const needsAttestation = (readiness?.blockers ?? []).some((blocker: Json) => String(blocker.code).startsWith("AUTHORED_RIGHTS_"));
  const renderable = readiness?.renderable === true && isHead;

  return <section className="storyboard" aria-labelledby="storyboard-heading">
    <h2 id="storyboard-heading" tabIndex={-1}>Brief to reviewed media</h2>
    <p data-storyboard-status role="status" aria-live="polite">{status}</p>
    {capabilities && <p data-capabilities-status>Renderer: composite {capabilities.renderer?.compositeAvailable ? "available" : "NOT available"}, animation {capabilities.renderer?.animationAvailable ? "available" : "NOT available"}, review {capabilities.renderer?.reviewAvailable ? "available" : "NOT available"}. Limits: {capabilities.limits?.maxScenes} scenes, {capabilities.limits?.maxShots} shots.</p>}
    {failure && <div role="alert" data-failure>
      <p><strong data-failure-code>{failure.code}</strong>: {failure.message}{failure.path && <> Path: <code data-failure-path>{failure.path}</code></>}</p>
      {failure.blockers && <ul data-failure-blockers>{failure.blockers.map((blocker, i) => <li key={i}>{blocker.code} {blocker.sceneId ? `(${blocker.sceneId}${blocker.shotId ? ` / ${blocker.shotId}` : ""})` : ""}</li>)}</ul>}
    </div>}
    {formErrors.length > 0 && <div role="alert" data-form-errors><ul>{formErrors.map((error) => <li key={error}>{error}</li>)}</ul></div>}

    <section aria-labelledby="brief-heading">
      <h3 id="brief-heading">1. Brief</h3>
      <form onSubmit={createFromBrief}>
        <label>Brief title<input value={briefTitle} onChange={(e) => setBriefTitle(e.target.value)} required maxLength={200} /></label>
        <label>Brief text (one paragraph becomes one scene with a placeholder shot)<textarea rows={4} value={briefText} onChange={(e) => setBriefText(e.target.value)} required maxLength={4000} /></label>
        <button type="submit" disabled={busy}>Create storyboard from brief</button>
      </form>
    </section>

    {view && <>
      <section aria-labelledby="editor-heading">
        <h3 id="editor-heading">2. Storyboard editor</h3>
        <dl>
          <dt>Storyboard id</dt><dd data-storyboard-id>{storyboardId}</dd>
          <dt>Version</dt><dd data-version>{view.versionNumber}</dd>
          <dt>Head version</dt><dd data-head-version>{view.headVersion}</dd>
          <dt>Version artifact</dt><dd data-version-artifact>{view.artifact.artifactId}</dd>
        </dl>
        {!isHead && <p role="alert" data-not-head>You are viewing an older version; it cannot be edited or rendered. Reload the head version to continue.</p>}
        <fieldset disabled={!isHead || busy}>
          <legend>Format and captions</legend>
          <label>Width<input value={draft.width} onChange={(e) => update((d) => { d.width = e.target.value; })} inputMode="numeric" /></label>
          <label>Height<input value={draft.height} onChange={(e) => update((d) => { d.height = e.target.value; })} inputMode="numeric" /></label>
          <label>Frames per second<input value={draft.fps} onChange={(e) => update((d) => { d.fps = e.target.value; })} inputMode="numeric" /></label>
          <label>Captions artifact id (optional)<input value={draft.captionsId} onChange={(e) => update((d) => { d.captionsId = e.target.value; })} /></label>
          <label>Captions exact version<input value={draft.captionsVersion} onChange={(e) => update((d) => { d.captionsVersion = e.target.value; })} /></label>
        </fieldset>
        {draft.scenes.map((scene, i) => <fieldset key={i} disabled={!isHead || busy} aria-label={`Scene ${i + 1}`} data-scene-row>
          <legend>Scene {i + 1}</legend>
          <label>Scene id<input value={scene.sceneId} onChange={(e) => update((d) => { d.scenes[i]!.sceneId = e.target.value; })} /></label>
          <label>Scene title<input value={scene.title} onChange={(e) => update((d) => { d.scenes[i]!.title = e.target.value; })} /></label>
          <label>Narration artifact id (optional)<input value={scene.narrationId} onChange={(e) => update((d) => { d.scenes[i]!.narrationId = e.target.value; })} /></label>
          <label>Narration exact version<input value={scene.narrationVersion} onChange={(e) => update((d) => { d.scenes[i]!.narrationVersion = e.target.value; })} /></label>
          {scene.shots.map((shot, j) => <fieldset key={j} aria-label={`Scene ${i + 1} shot ${j + 1}`} data-shot-row>
            <legend>Scene {i + 1} shot {j + 1}</legend>
            <label>Shot id<input value={shot.shotId} onChange={(e) => update((d) => { d.scenes[i]!.shots[j]!.shotId = e.target.value; })} /></label>
            <label>Duration (ms)<input value={shot.durationMs} inputMode="numeric" onChange={(e) => update((d) => { d.scenes[i]!.shots[j]!.durationMs = e.target.value; })} /></label>
            <label>Source kind<select value={shot.kind} onChange={(e) => update((d) => { d.scenes[i]!.shots[j]!.kind = e.target.value as Kind; })}>{KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
            {shot.kind === "ASSET" && <>
              <label>Asset artifact id<input value={shot.artifactId} onChange={(e) => update((d) => { d.scenes[i]!.shots[j]!.artifactId = e.target.value; })} /></label>
              <label>Asset exact version<input value={shot.artifactVersionId} onChange={(e) => update((d) => { d.scenes[i]!.shots[j]!.artifactVersionId = e.target.value; })} /></label>
              <label>Asset start (ms)<input value={shot.sourceInMs} inputMode="numeric" onChange={(e) => update((d) => { d.scenes[i]!.shots[j]!.sourceInMs = e.target.value; })} /></label>
            </>}
            {shot.kind === "PLACEHOLDER" && <label>Placeholder note<input value={shot.note} onChange={(e) => update((d) => { d.scenes[i]!.shots[j]!.note = e.target.value; })} /></label>}
            {shot.kind === "ANIMATION" && <label>Animation spec (JSON; size, frame rate and frame count are derived)<textarea rows={5} value={shot.spec} onChange={(e) => update((d) => { d.scenes[i]!.shots[j]!.spec = e.target.value; })} /></label>}
            <div>
              <button type="button" onClick={() => update((d) => move(d.scenes[i]!.shots, j, -1))}>Move shot {j + 1} of scene {i + 1} up</button>
              <button type="button" onClick={() => update((d) => move(d.scenes[i]!.shots, j, 1))}>Move shot {j + 1} of scene {i + 1} down</button>
              <button type="button" onClick={() => update((d) => { d.scenes[i]!.shots.splice(j, 1); })}>Remove shot {j + 1} of scene {i + 1}</button>
            </div>
          </fieldset>)}
          <div>
            <button type="button" onClick={() => update((d) => { d.scenes[i]!.shots.push(blankShot(d.scenes.reduce((n, s) => n + s.shots.length, 0) + 1)); })}>Add shot to scene {i + 1}</button>
            <button type="button" onClick={() => update((d) => move(d.scenes, i, -1))}>Move scene {i + 1} up</button>
            <button type="button" onClick={() => update((d) => move(d.scenes, i, 1))}>Move scene {i + 1} down</button>
            <button type="button" onClick={() => update((d) => { d.scenes.splice(i, 1); })}>Remove scene {i + 1}</button>
          </div>
        </fieldset>)}
        <div>
          <button type="button" disabled={!isHead || busy} onClick={() => update((d) => { d.scenes.push(blankScene(d.scenes.length + 1)); })}>Add scene</button>
          <button type="button" disabled={!isHead || busy} onClick={save}>Save new version</button>
          <button type="button" disabled={busy} onClick={() => void run("reload", "Loading the head version", async () => { await refresh(storyboardId); setStatus("Loaded the head version from the host."); })}>Reload head version</button>
        </div>
        <div className="storyboard-scroll" role="region" aria-label="Derived story time" tabIndex={0}>
          <table data-timeline>
            <caption>Derived story time of version {view.versionNumber} ({view.timeline?.totalMs} ms, {view.timeline?.totalFrames} frames at {view.timeline?.framesPerSecond} fps)</caption>
            <thead><tr><th scope="col">Scene</th><th scope="col">Shot</th><th scope="col">Source</th><th scope="col">Start (ms)</th><th scope="col">End (ms)</th><th scope="col">Start frame</th><th scope="col">Frames</th></tr></thead>
            <tbody>{(view.timeline?.scenes ?? []).flatMap((scene: Json) => (scene.shots as Json[]).map((shot) =>
              <tr key={shot.shotId} data-timeline-shot={shot.shotId}><th scope="row">{scene.sceneId}</th><td>{shot.shotId}</td><td>{shot.kind}</td><td>{shot.startMs}</td><td>{shot.endMs}</td><td>{shot.startFrame}</td><td>{shot.frames}</td></tr>))}</tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="readiness-heading">
        <h3 id="readiness-heading">3. Readiness</h3>
        <p data-renderable>{readiness?.renderable ? "Every shot is renderable now." : "Not renderable: at least one shot or the renderer is blocked."}</p>
        <div className="storyboard-scroll" role="region" aria-label="Shot readiness" tabIndex={0}>
          <table data-readiness>
            <caption>Per-shot readiness derived from live state</caption>
            <thead><tr><th scope="col">Shot</th><th scope="col">State</th><th scope="col">Typed reasons</th></tr></thead>
            <tbody>{(readiness?.shots ?? []).map((shot: Json) => <tr key={shot.shotId} data-shot-state={shot.shotId}><th scope="row">{shot.shotId}</th><td>{shot.state}</td>
              <td>{(shot.reasons as Json[]).map((reason, i) => <span key={i} data-reason={reason.code}>{reason.code} <code>{reason.path}</code> </span>)}</td></tr>)}</tbody>
          </table>
        </div>
        {(readiness?.blockers ?? []).filter((blocker: Json) => !blocker.shotId).length > 0 && <ul data-global-blockers>{((readiness?.blockers ?? []) as Json[]).filter((blocker) => !blocker.shotId).map((blocker, i) =>
          <li key={i}>{blocker.code} <code>{blocker.path}</code> {blocker.sceneId ? `(scene ${blocker.sceneId})` : ""}: {blocker.message}</li>)}</ul>}
        {needsAttestation && isHead && <form onSubmit={attest} data-attest-form>
          <p>The animation shots are authored content. Rights for them come from a statement you make about this exact storyboard version. The host never makes this statement for you.</p>
          <label>Basis of your statement<textarea rows={3} value={basis} onChange={(e) => setBasis(e.target.value)} required maxLength={500} /></label>
          <label><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I am the rights holder of this authored content and grant PROCESSING for this exact version.</label>
          <button type="submit" disabled={busy || !confirmed || basis.trim().length < 10}>Record my rights statement</button>
        </form>}
        <button type="button" disabled={busy} onClick={() => void run("readiness", "Checking readiness", async () => { setReadiness(await port.readiness(storyboardId) as Json); setStatus("Readiness re-derived from the host."); })}>Check readiness</button>
      </section>

      <section aria-labelledby="render-heading">
        <h3 id="render-heading">4. Render</h3>
        <button type="button" onClick={doRender} disabled={!renderable || busy} aria-describedby="render-hint">Render storyboard</button>
        <p id="render-hint" data-render-hint>{renderable ? "Every shot is renderable; the host renders the head version." : "Render is disabled until every shot is renderable and this is the head version."}</p>
        {render && <section data-render-result aria-label="Render result">
          <dl>
            <dt>Render id</dt><dd data-render-id>{render.renderId}</dd>
            <dt>Storyboard version</dt><dd data-render-version>{render.storyboardVersion}</dd>
            <dt>Frames</dt><dd data-render-frames>{render.lineage?.frameCount}</dd>
            <dt>Duration (s)</dt><dd data-render-duration>{render.lineage?.durationSeconds}</dd>
            <dt>SHA-256</dt><dd data-render-sha256>{render.artifact?.sha256}</dd>
          </dl>
          <div className="storyboard-scroll" role="region" aria-label="Render lineage" tabIndex={0}>
            <table data-lineage>
              <caption>Exact source versions used (erasure follows these)</caption>
              <thead><tr><th scope="col">Clip</th><th scope="col">Kind</th><th scope="col">Artifact</th><th scope="col">Version</th></tr></thead>
              <tbody>{(render.lineage?.sources ?? []).map((source: Json) => <tr key={source.clipId} data-source-clip={source.clipId}><th scope="row">{source.clipId}</th><td>{source.trackKind}</td><td>{source.artifactId}</td><td>{source.artifactVersionId}</td></tr>)}</tbody>
            </table>
          </div>
          <DevVerifiedContent key={render.artifact.artifactVersionId} reader={{ readArtifactContent: readContent }} artifact={render.artifact} kind="mp4" maxBytes={64 * 1024 * 1024} />
        </section>}
      </section>

      <section aria-labelledby="review-heading">
        <h3 id="review-heading">5. Review handoff</h3>
        <p>The render of this exact storyboard version becomes a version-specific review subject. Editing the storyboard makes that review STALE. Nothing here is an approval.</p>
        <button type="button" onClick={openReview} disabled={!render || busy}>Open render for review</button>
        <button type="button" onClick={refreshReview} disabled={busy || !render}>Refresh review state</button>
        {review && <dl data-review>
          <dt>Review case</dt><dd data-review-case>{review.review?.reviewCaseId ?? "none yet"}</dd>
          <dt>Currentness</dt><dd data-review-currentness>{review.review?.currentness}</dd>
          <dt>Latest decision</dt><dd data-review-decision>{review.review?.latestDecision}</dd>
          <dt>Establishes approval</dt><dd data-review-approval>{String(review.review?.establishesApproval)}</dd>
        </dl>}
        {review?.review?.currentness === "STALE" && <p role="alert" data-review-stale>This review is STALE: the storyboard has a later version. Render and review the head version.</p>}
        {review?.reviewPath && <p><a href="/dev-review.html" data-review-link>Open the review page</a> and enter case <code>{review.review.reviewCaseId}</code> as the assigned reviewer.</p>}
      </section>
    </>}
  </section>;
}
