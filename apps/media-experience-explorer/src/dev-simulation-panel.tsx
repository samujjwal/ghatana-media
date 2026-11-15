import React from "react";
import { describeContentFailure, readVerifiedContent, type RegisteredArtifact } from "@audio-video/ui/screens";
import { DevSimulationHostError, type DevSimulationPort } from "./dev-simulation-client";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

type ModelType = "NEWTON_CONSTANT_FORCE" | "DAMPED_SPRING" | "PROJECTILE";
const UNIT_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["Mass", ["kg", "g"]], ["Length", ["m", "km", "cm", "mm"]], ["Time", ["s", "ms"]], ["Velocity", ["m/s", "km/h", "cm/s"]],
  ["Acceleration", ["m/s^2"]], ["Force", ["N", "mN", "kN"]], ["Spring constant", ["N/m"]], ["Linear damping", ["kg/s", "N*s/m"]],
  ["Quadratic drag", ["kg/m"]], ["Energy", ["J", "kJ"]], ["Angle", ["rad", "deg"]],
];
const OBSERVABLES = ["POSITION_X", "POSITION_Y", "VELOCITY_X", "VELOCITY_Y", "SPEED", "TOTAL_ENERGY", "TIME"] as const;
const OBSERVABLE_UNIT: Readonly<Record<string, string>> = {
  POSITION_X: "m", POSITION_Y: "m", VELOCITY_X: "m/s", VELOCITY_Y: "m/s", SPEED: "m/s", TOTAL_ENERGY: "J", TIME: "s",
};

interface Quantity { value: string; unit: string }
const qty = (value: string, unit: string): Quantity => ({ value, unit });

interface Form {
  model: ModelType;
  mass: Quantity; force: Quantity; springConstant: Quantity; damping: Quantity;
  dragLaw: "NONE" | "LINEAR" | "QUADRATIC"; dragCoefficient: Quantity;
  position: Quantity; velocity: Quantity; x: Quantity; y: Quantity; speed: Quantity; angle: Quantity;
  duration: Quantity; maxStep: Quantity; minStep: Quantity; positionTolerance: Quantity; velocityTolerance: Quantity;
  maxAcceptedSteps: string; maxIterations: string; mode: "ADAPTIVE" | "FIXED_STEP"; terminate: boolean;
  constrain: boolean; constraintId: string; observable: string; aggregate: "FINAL" | "MAX" | "MIN"; op: "LE" | "GE"; limit: Quantity;
  video: boolean;
}

const baseSolver = {
  duration: qty("2", "s"), maxStep: qty("0.05", "s"), minStep: qty("0.00001", "s"), positionTolerance: qty("0.000000001", "m"),
  velocityTolerance: qty("0.000000001", "m/s"), maxAcceptedSteps: "5000", maxIterations: "100000", mode: "ADAPTIVE" as const, terminate: false,
};
const defaults = (model: ModelType): Form => ({
  model, mass: qty(model === "NEWTON_CONSTANT_FORCE" ? "2" : model === "DAMPED_SPRING" ? "0.5" : "0.145", "kg"), force: qty("6", "N"),
  springConstant: qty("200", "N/m"), damping: qty("1.2", "kg/s"), dragLaw: "QUADRATIC", dragCoefficient: qty("0.0012", "kg/m"),
  position: qty(model === "DAMPED_SPRING" ? "0.1" : "0", "m"), velocity: qty(model === "DAMPED_SPRING" ? "0.3" : "0", "m/s"),
  x: qty("0", "m"), y: qty("1", "m"), speed: qty("40", "m/s"), angle: qty("40", "deg"),
  ...baseSolver,
  ...(model === "PROJECTILE" ? { duration: qty("30", "s"), terminate: true } : {}),
  constrain: false, constraintId: "limit-1", observable: "POSITION_X", aggregate: "FINAL", op: "LE", limit: qty("1", "m"), video: false,
});

const LABELS: Readonly<Record<string, string>> = {
  timeSeconds: "Time (s)", positionXMeters: "Position x (m)", positionYMeters: "Position y (m)", velocityXMetersPerSecond: "Velocity x (m/s)",
  velocityYMetersPerSecond: "Velocity y (m/s)", accelerationXMetersPerSecondSquared: "Acceleration x (m/s²)",
  accelerationYMetersPerSecondSquared: "Acceleration y (m/s²)", speedMetersPerSecond: "Speed (m/s)", totalEnergyJoules: "Total energy (J)",
};

/** `$.model.mass.unit` -> `f-model-mass-unit`; `$.constraints[0].limit.unit` -> `f-constraints-0-limit-unit`. */
const pathToId = (path: string): string => `f-${path.replace(/^\$\.?/u, "").replace(/\[(\d+)\]/gu, "-$1").replace(/\./gu, "-")}`;

const fmt = (value: unknown): string => typeof value === "number" ? (Number.isInteger(value) && Math.abs(value) < 1e15 ? String(value) : value.toPrecision(10)) : String(value);

interface Artifact extends RegisteredArtifact { readonly artifactPath: string }
const parseArtifact = (value: unknown): Artifact | null => {
  if (!isRecord(value)) return null;
  const { artifactId, artifactVersionId, contentType, sizeBytes, sha256 } = value;
  if (typeof artifactId !== "string" || typeof artifactVersionId !== "string" || typeof contentType !== "string" || typeof sha256 !== "string") return null;
  return { artifactId, artifactVersionId, contentType, sizeBytes: typeof sizeBytes === "number" ? sizeBytes : null, sha256, artifactPath: String(value.artifactPath ?? "") };
};

interface View {
  readonly simulationId: string; readonly outcome: "COMPLETED" | "ABSTAINED"; readonly replayed: boolean; readonly result: Json;
  readonly plot: Artifact | null; readonly video: Artifact | null;
}
function parseView(body: unknown): View {
  const bad = (): never => { throw new DevSimulationHostError("INVALID_RESPONSE", 0, "The host returned an invalid simulation view."); };
  if (!isRecord(body) || body.scope !== "DEV_ONLY" || !isRecord(body.result) || typeof body.simulationId !== "string") return bad();
  if (body.outcome !== "COMPLETED" && body.outcome !== "ABSTAINED") return bad();
  return { simulationId: body.simulationId, outcome: body.outcome, replayed: body.replayed === true, result: body.result,
    plot: parseArtifact(body.plotArtifact), video: parseArtifact(body.videoArtifact) };
}

interface Failure { readonly code: string; readonly message: string; readonly path: string | null; readonly tone: string; readonly details: Json }
function describeFailure(error: unknown): Failure {
  const host = error instanceof DevSimulationHostError ? error : new DevSimulationHostError("INVALID_RESPONSE", 0, error instanceof Error ? error.message : "Unexpected failure.");
  const path = typeof host.details?.path === "string" ? host.details.path : null;
  const tone = host.status === 0 ? "unknown" : host.status === 403 ? "denied" : host.status === 404 ? "notFound" : host.status === 409 ? "conflict"
    : host.code === "SIMULATION_BUDGET_EXCEEDED" ? "budget" : host.status === 422 ? "invalid" : "unavailable";
  let message = host.message;
  if (tone === "budget" && host.details) message += ` (${String(host.details.limit)}: requested ${String(host.details.requested)}, ceiling ${String(host.details.ceiling)}).`;
  if (host.code === "OUTCOME_UNKNOWN") message = "The host did not confirm the outcome. Run again: the same request identifier is reused, so nothing is run twice.";
  return { code: host.code, message, path, tone, details: host.details ?? {} };
}

let counter = 0;
const newRequestId = (): string => `sim-${typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${(counter++).toString(36)}`}`;

function QuantityField({ id, label, value, onChange, hint }: { id: string; label: string; value: Quantity; onChange: (next: Quantity) => void; hint?: string }): React.ReactElement {
  return <div className="sim-field" data-field={id}>
    <label htmlFor={`f-${id}-value`}>{label}</label>
    <div className="sim-quantity">
      <input id={`f-${id}-value`} inputMode="decimal" autoComplete="off" value={value.value} onChange={(event) => onChange({ ...value, value: event.target.value })} aria-describedby={`f-${id}-hint`} />
      <label className="sim-unit-label" htmlFor={`f-${id}-unit`}>{label} unit</label>
      <select id={`f-${id}-unit`} value={value.unit} onChange={(event) => onChange({ ...value, unit: event.target.value })}>
        {UNIT_GROUPS.map(([group, units]) => <optgroup key={group} label={group}>{units.map((unit) => <option key={unit} value={unit}>{unit}</option>)}</optgroup>)}
      </select>
    </div>
    <span id={`f-${id}-hint`} className="sim-count">{hint ?? "A number and its unit; the host checks that the unit has the right dimension."}</span>
  </div>;
}

function VerifiedImage({ port, artifact, alt }: { port: DevSimulationPort; artifact: Artifact; alt: string }): React.ReactElement {
  const [state, setState] = React.useState<{ phase: "loading" } | { phase: "ok"; url: string; text: string } | { phase: "failed"; text: string }>({ phase: "loading" });
  React.useEffect(() => {
    let alive = true;
    let url: string | null = null;
    readVerifiedContent({ readArtifactContent: port.readArtifactContent }, artifact).then((verified) => {
      url = URL.createObjectURL(new Blob([verified.bytes as BlobPart], { type: verified.contentType }));
      if (alive) setState({ phase: "ok", url, text: `Plot bytes verified against the registered version: SHA-256 ${verified.sha256} (${verified.bytes.byteLength} bytes).` });
    }).catch((error: unknown) => { const shown = describeContentFailure(error); if (alive) setState({ phase: "failed", text: `${shown.code}: ${shown.text}` }); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [port, artifact]);
  return <figure>
    <p role={state.phase === "failed" ? "alert" : "status"} aria-live="polite" data-plot-status>{state.phase === "loading" ? "Reading the plot and verifying its SHA-256…" : state.text}</p>
    {state.phase === "ok" && <img className="sim-plot" src={state.url} alt={alt} data-verified-plot width={800} height={400} />}
  </figure>;
}

function VideoPlayback({ port, video }: { port: DevSimulationPort; video: Artifact }): React.ReactElement {
  const [state, setState] = React.useState<{ phase: "idle" } | { phase: "loading" } | { phase: "verified"; url: string; text: string } | { phase: "failed"; text: string }>({ phase: "idle" });
  const urls = React.useRef<string[]>([]);
  React.useEffect(() => () => { for (const url of urls.current) URL.revokeObjectURL(url); }, []);
  const load = async (): Promise<void> => {
    setState({ phase: "loading" });
    try {
      const verified = await readVerifiedContent({ readArtifactContent: port.readArtifactContent }, video);
      const url = URL.createObjectURL(new Blob([verified.bytes as BlobPart], { type: verified.contentType }));
      urls.current.push(url);
      setState({ phase: "verified", url, text: `Bytes verified against the registered version: SHA-256 ${verified.sha256} (${verified.bytes.byteLength} bytes).` });
    } catch (error) { const shown = describeContentFailure(error); setState({ phase: "failed", text: `${shown.code}: ${shown.text}` }); }
  };
  return <section aria-label="Animation playback" data-playback-state={state.phase}>
    <p><button type="button" onClick={() => void load()} disabled={state.phase === "loading" || state.phase === "verified"}>Load the animation (verify bytes first)</button></p>
    <p role={state.phase === "failed" ? "alert" : "status"} aria-live="polite" data-playback-status>
      {state.phase === "idle" ? "Animation not loaded." : state.phase === "loading" ? "Reading the animation and verifying its SHA-256…" : state.text}</p>
    {state.phase === "verified" && <video controls preload="metadata" muted playsInline src={state.url} data-verified-preview="simulation-video" aria-label="Animation of the simulated trajectory and energy" />}
  </section>;
}

function plotAlt(result: Json): string {
  const trace = isRecord(result.trace) ? result.trace : null;
  const rows = trace && Array.isArray(trace.rows) ? trace.rows as number[][] : [];
  if (rows.length < 2) return "Plot of the simulated trajectory and total energy.";
  const first = rows[0]!; const last = rows[rows.length - 1]!;
  return `Left panel: the simulated path from (${fmt(first[1])} m, ${fmt(first[2])} m) to (${fmt(last[1])} m, ${fmt(last[2])} m). Right panel: total energy from ${fmt(first[8])} J to ${fmt(last[8])} J over ${fmt(last[0])} s.`;
}

function Result({ port, view }: { port: DevSimulationPort; view: View }): React.ReactElement {
  const { result } = view;
  const title = React.useRef<HTMLHeadingElement | null>(null);
  React.useEffect(() => { title.current?.focus(); }, [view.simulationId, view.replayed]);
  const heading = <h3 id="sim-result-title" tabIndex={-1} ref={title}>Simulation result: {view.outcome}</h3>;
  const replay = view.replayed ? <p data-replayed>Replayed: the same request identifier returned the stored result; the solver was not run again.</p> : null;
  const ids = <p>Simulation id <code data-simulation-id>{view.simulationId}</code>; scenario SHA-256 <code data-scenario-sha>{String(result.scenarioSha256)}</code>.</p>;
  if (view.outcome === "ABSTAINED") {
    const reasons = Array.isArray(result.reasons) ? result.reasons.filter(isRecord) : [];
    const diagnostics = isRecord(result.diagnostics) ? result.diagnostics : {};
    return <section className="sim-result" aria-labelledby="sim-result-title" data-sim-result data-outcome="ABSTAINED">
      {heading}{replay}
      <div role="alert" className="sim-abstained" data-abstained>
        <p><strong>The solver abstained. No trace and no observable value is shown, because this pass cannot be trusted.</strong></p>
        <ul data-reasons>{reasons.map((reason, index) => <li key={index} data-reason-code={String(reason.code)}>
          <code>{String(reason.code)}</code>: {String(reason.message)} <span>Where: <code>{String(reason.path)}</code>.</span>
          {isRecord(reason.details) && Object.keys(reason.details).length > 0 && <span> Details: <code>{JSON.stringify(reason.details)}</code></span>}</li>)}</ul>
        <p data-diagnostics>Solver counters: {fmt(diagnostics.acceptedSteps)} accepted steps, {fmt(diagnostics.iterations)} iterations, reached t = {fmt(diagnostics.reachedTimeSeconds)} s.</p>
      </div>
      {ids}
    </section>;
  }
  const verification = isRecord(result.verification) ? result.verification : {};
  const energy = isRecord(verification.energy) ? verification.energy : {};
  const observables = isRecord(result.observables) ? result.observables : {};
  const constraints = Array.isArray(verification.constraints) ? verification.constraints.filter(isRecord) : [];
  const trace = isRecord(result.trace) ? result.trace : { columns: [], rows: [] };
  const columns = Array.isArray(trace.columns) ? trace.columns as string[] : [];
  const rows = Array.isArray(trace.rows) ? trace.rows as number[][] : [];
  const shown = rows.length > 300 ? [...rows.slice(0, 150), ...rows.slice(-150)] : rows;
  return <section className="sim-result" aria-labelledby="sim-result-title" data-sim-result data-outcome="COMPLETED">
    {heading}{replay}
    <p data-result-summary>Solved in {fmt(verification.acceptedSteps)} accepted steps ({fmt(verification.iterations)} iterations); largest local error ratio {fmt(verification.maxErrorRatio)} (must be at most 1); ended by {String(verification.termination)}.</p>
    <h4>Final observables</h4>
    <dl data-observables>{Object.entries(observables).map(([key, value]) => <React.Fragment key={key}><dt>{LABELS[key] ?? key}</dt><dd data-observable={key}>{fmt(value)}</dd></React.Fragment>)}</dl>
    <h4>Why this pass is trusted</h4>
    <dl data-verification>
      <dt>Energy law</dt><dd data-energy-law>{String(energy.lawClass)}: relative {String(energy.lawClass).startsWith("CONS") ? "drift" : "increase"} {fmt(energy.relativeDrift)} against tolerance {fmt(energy.tolerance)}</dd>
      <dt>Model domain</dt><dd>Inside the Newtonian domain (non-relativistic{isRecord(result.scenario) && isRecord(result.scenario.model) && result.scenario.model.dragLaw && result.scenario.model.dragLaw !== "NONE" ? ", subsonic for the drag law" : ""})</dd>
      <dt>Maximum speed</dt><dd>{fmt(verification.maxSpeedMetersPerSecond)} m/s</dd>
    </dl>
    {isRecord(result.impact) && <p data-impact>Ground impact at t = {fmt(result.impact.timeSeconds)} s, range {fmt(result.impact.rangeMeters)} m, speed {fmt(result.impact.speedMetersPerSecond)} m/s.</p>}
    {constraints.length > 0 && <div className="sim-scroll" role="region" aria-label="Declared constraints" tabIndex={0}><table data-constraints><caption>Declared constraints (all satisfied; evaluated at accepted solver samples)</caption>
      <thead><tr><th scope="col">Id</th><th scope="col">Observable</th><th scope="col">Rule</th><th scope="col">Observed (SI)</th></tr></thead>
      <tbody>{constraints.map((c) => <tr key={String(c.id)}><td>{String(c.id)}</td><td>{String(c.aggregate)} {String(c.observable)}</td><td>{String(c.op) === "LE" ? "at most" : "at least"} {fmt(c.limitSi)}</td><td>{fmt(c.observedSi)}</td></tr>)}</tbody></table></div>}
    {view.plot && <VerifiedImage port={port} artifact={view.plot} alt={plotAlt(result)} />}
    {view.video && <VideoPlayback port={port} video={view.video} />}
    <details><summary>Trace ({rows.length} samples{rows.length > shown.length ? `, first and last ${shown.length / 2} shown` : ""})</summary>
      <div className="sim-scroll" role="region" aria-label="Solver trace" tabIndex={0}>
        <table data-trace><caption>Solver samples in SI units</caption>
          <thead><tr>{columns.map((column) => <th key={column} scope="col">{LABELS[column] ?? column}</th>)}</tr></thead>
          <tbody>{shown.map((row, index) => <tr key={index} data-row={index}>{row.map((value, i) => <td key={i}>{fmt(value)}</td>)}</tr>)}</tbody></table>
      </div>
    </details>
    {ids}
  </section>;
}

function buildScenario(form: Form): { scenario?: Json; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const num = (q: Quantity, id: string): Json | null => {
    const text = q.value.trim();
    const value = text === "" ? Number.NaN : Number(text);
    if (!Number.isFinite(value)) { errors[`f-${id}-value`] = "Enter a finite number."; return null; }
    return { value, unit: q.unit };
  };
  const int = (text: string, id: string): number | null => {
    const value = Number(text.trim());
    if (text.trim() === "" || !Number.isInteger(value)) { errors[`f-${id}`] = "Enter a whole number."; return null; }
    return value;
  };
  const model: Json = { type: form.model, mass: num(form.mass, "model-mass") };
  let initial: Json;
  if (form.model === "NEWTON_CONSTANT_FORCE") model.force = num(form.force, "model-force");
  if (form.model === "DAMPED_SPRING") { model.springConstant = num(form.springConstant, "model-springConstant"); model.damping = num(form.damping, "model-damping"); }
  if (form.model === "PROJECTILE") {
    model.drag = form.dragLaw === "NONE" ? { law: "NONE" } : { law: form.dragLaw, coefficient: num(form.dragCoefficient, "model-drag-coefficient") };
    initial = { x: num(form.x, "initial-x"), y: num(form.y, "initial-y"), speed: num(form.speed, "initial-speed"), angle: num(form.angle, "initial-angle") };
  } else {
    initial = { position: num(form.position, "initial-position"), velocity: num(form.velocity, "initial-velocity") };
  }
  const solver: Json = {
    duration: num(form.duration, "solver-duration"), maxStep: num(form.maxStep, "solver-maxStep"), minStep: num(form.minStep, "solver-minStep"),
    positionTolerance: num(form.positionTolerance, "solver-positionTolerance"), velocityTolerance: num(form.velocityTolerance, "solver-velocityTolerance"),
    maxAcceptedSteps: int(form.maxAcceptedSteps, "solver-maxAcceptedSteps"), maxIterations: int(form.maxIterations, "solver-maxIterations"), mode: form.mode,
  };
  if (form.model === "PROJECTILE" && form.terminate) solver.terminateOnGroundImpact = true;
  const scenario: Json = { model, initial, solver, render: { plot: true, video: form.video } };
  if (form.constrain) scenario.constraints = [{ id: form.constraintId, observable: form.observable, aggregate: form.aggregate, op: form.op, limit: num(form.limit, "constraints-0-limit") }];
  return Object.keys(errors).length > 0 ? { errors } : { scenario, errors };
}

/**
 * DEV_ONLY scientific simulation: author a unit-checked mechanics scenario, run the host's real solver and read back the host's
 * validated result. Every unit and range check is the host's (a typed 422 names the JSON path and focus moves to that field).
 * An abstained pass shows its reasons and no values at all; a completed pass shows only what the host stored, with the plot and
 * animation verified against their registered SHA-256 before they are shown.
 */
export function DevSimulationPanel({ simulation }: { simulation: DevSimulationPort }): React.ReactElement {
  const [form, setForm] = React.useState<Form>(() => defaults("DAMPED_SPRING"));
  const [status, setStatus] = React.useState<string>("Reading host limits…");
  const [busy, setBusy] = React.useState(false);
  const [view, setView] = React.useState<View | null>(null);
  const [failure, setFailure] = React.useState<Failure | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [reopenId, setReopenId] = React.useState("");
  const request = React.useRef<{ key: string; id: string } | null>(null);
  const failureRef = React.useRef<HTMLDivElement | null>(null);
  const set = <K extends keyof Form>(key: K, value: Form[K]): void => setForm((previous) => ({ ...previous, [key]: value }));

  React.useEffect(() => {
    let alive = true;
    simulation.getStatus().then((response) => {
      const body = response.body;
      if (!isRecord(body) || body.scope !== "DEV_ONLY" || !isRecord(body.limits) || !isRecord(body.solver)) throw new DevSimulationHostError("INVALID_RESPONSE", 0, "The host returned an invalid simulation status.");
      const limits = body.limits;
      const video = isRecord(body.video) && body.video.available === true;
      if (alive) setStatus(`Host limits: at most ${String(limits.maxAcceptedSteps)} accepted steps, ${String(limits.maxIterations)} iterations, ${String(limits.maxDurationSeconds)} s duration; the ${String(body.solver.id)} solver is order ${String(body.solver.order)}. Animation: ${video ? "available" : "not available on this host"}.`);
    }).catch((error: unknown) => { if (alive) setStatus(`Host limits unavailable: ${describeFailure(error).message}`); });
    return () => { alive = false; };
  }, [simulation]);

  const focusField = (id: string): boolean => {
    const element = document.getElementById(id) ?? document.getElementById(`${id}-value`);
    if (element) { element.focus(); return true; }
    return false;
  };

  const show = (next: View): void => { setView(next); setFailure(null); setFieldErrors({}); setReopenId(next.simulationId); };
  const fail = (error: unknown): void => {
    const described = describeFailure(error);
    setFailure(described);
    setView(null);
    window.setTimeout(() => { if (!(described.path && focusField(pathToId(described.path)))) failureRef.current?.focus(); }, 0);
  };

  const run = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const built = buildScenario(form);
    if (!built.scenario) {
      setFieldErrors(built.errors); setFailure(null);
      const first = Object.keys(built.errors)[0]!;
      window.setTimeout(() => focusField(first), 0);
      return;
    }
    setFieldErrors({});
    const key = JSON.stringify(built.scenario);
    if (!request.current || request.current.key !== key) request.current = { key, id: newRequestId() };
    setBusy(true);
    try {
      const response = await simulation.run({ requestId: request.current.id, scenario: built.scenario });
      show(parseView(response.body));
    } catch (error) { fail(error); } finally { setBusy(false); }
  };

  const reopen = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || !reopenId.trim()) return;
    setBusy(true);
    try { show(parseView((await simulation.reopen(reopenId.trim())).body)); } catch (error) { fail(error); } finally { setBusy(false); }
  };

  const errorText = (id: string): string | undefined => fieldErrors[id];

  return <section className="sim" aria-labelledby="sim-title" data-sim-panel>
    <h2 id="sim-title">Scientific simulation</h2>
    <p role="status" aria-live="polite" data-status-line>{status}</p>
    <form onSubmit={(event) => void run(event)} aria-label="Simulation scenario" noValidate>
      <fieldset><legend>Model</legend>
        <div className="sim-field"><label htmlFor="f-model-type">Physical model</label>
          <select id="f-model-type" value={form.model} onChange={(event) => setForm(defaults(event.target.value as ModelType))}>
            <option value="NEWTON_CONSTANT_FORCE">Newton: constant force on a mass</option>
            <option value="DAMPED_SPRING">Damped spring</option>
            <option value="PROJECTILE">Projectile with optional drag</option>
          </select></div>
        <QuantityField id="model-mass" label="Mass" value={form.mass} onChange={(v) => set("mass", v)} />
        {form.model === "NEWTON_CONSTANT_FORCE" && <QuantityField id="model-force" label="Force" value={form.force} onChange={(v) => set("force", v)} />}
        {form.model === "DAMPED_SPRING" && <>
          <QuantityField id="model-springConstant" label="Spring constant" value={form.springConstant} onChange={(v) => set("springConstant", v)} />
          <QuantityField id="model-damping" label="Damping coefficient" value={form.damping} onChange={(v) => set("damping", v)} hint="Zero gives an undamped (energy-conserving) spring; it must not be negative." /></>}
        {form.model === "PROJECTILE" && <>
          <div className="sim-field"><label htmlFor="f-model-drag-law">Drag law</label>
            <select id="f-model-drag-law" value={form.dragLaw} onChange={(event) => { const law = event.target.value as Form["dragLaw"]; setForm((p) => ({ ...p, dragLaw: law, dragCoefficient: law === "LINEAR" ? qty("0.05", "kg/s") : qty("0.0012", "kg/m") })); }}>
              <option value="NONE">None (vacuum)</option><option value="LINEAR">Linear (F = -b v)</option><option value="QUADRATIC">Quadratic (F = -k |v| v)</option></select></div>
          {form.dragLaw !== "NONE" && <QuantityField id="model-drag-coefficient" label="Drag coefficient" value={form.dragCoefficient} onChange={(v) => set("dragCoefficient", v)} />}</>}
      </fieldset>
      <fieldset><legend>Initial state</legend>
        {form.model === "PROJECTILE" ? <>
          <QuantityField id="initial-x" label="Start x" value={form.x} onChange={(v) => set("x", v)} />
          <QuantityField id="initial-y" label="Start height y" value={form.y} onChange={(v) => set("y", v)} />
          <QuantityField id="initial-speed" label="Launch speed" value={form.speed} onChange={(v) => set("speed", v)} />
          <QuantityField id="initial-angle" label="Launch angle" value={form.angle} onChange={(v) => set("angle", v)} /></> : <>
          <QuantityField id="initial-position" label="Position" value={form.position} onChange={(v) => set("position", v)} />
          <QuantityField id="initial-velocity" label="Velocity" value={form.velocity} onChange={(v) => set("velocity", v)} /></>}
      </fieldset>
      <fieldset><legend>Solver</legend>
        <QuantityField id="solver-duration" label="Duration" value={form.duration} onChange={(v) => set("duration", v)} />
        <QuantityField id="solver-maxStep" label="Largest step" value={form.maxStep} onChange={(v) => set("maxStep", v)} />
        <QuantityField id="solver-minStep" label="Smallest step" value={form.minStep} onChange={(v) => set("minStep", v)} />
        <QuantityField id="solver-positionTolerance" label="Position tolerance" value={form.positionTolerance} onChange={(v) => set("positionTolerance", v)} />
        <QuantityField id="solver-velocityTolerance" label="Velocity tolerance" value={form.velocityTolerance} onChange={(v) => set("velocityTolerance", v)} />
        <div className="sim-field"><label htmlFor="f-solver-maxAcceptedSteps">Accepted-step budget</label>
          <input id="f-solver-maxAcceptedSteps" inputMode="numeric" value={form.maxAcceptedSteps} onChange={(e) => set("maxAcceptedSteps", e.target.value)} />
          {errorText("f-solver-maxAcceptedSteps") && <span className="sim-error" role="alert">{errorText("f-solver-maxAcceptedSteps")}</span>}</div>
        <div className="sim-field"><label htmlFor="f-solver-maxIterations">Iteration budget</label>
          <input id="f-solver-maxIterations" inputMode="numeric" value={form.maxIterations} onChange={(e) => set("maxIterations", e.target.value)} />
          {errorText("f-solver-maxIterations") && <span className="sim-error" role="alert">{errorText("f-solver-maxIterations")}</span>}</div>
        <div className="sim-field"><label htmlFor="f-solver-mode">Step control</label>
          <select id="f-solver-mode" value={form.mode} onChange={(e) => set("mode", e.target.value as Form["mode"])}>
            <option value="ADAPTIVE">Adaptive (meets the tolerances or abstains)</option><option value="FIXED_STEP">Fixed step (largest step throughout)</option></select></div>
        {form.model === "PROJECTILE" && <div className="sim-field"><label htmlFor="f-solver-terminate"><input id="f-solver-terminate" type="checkbox" checked={form.terminate} onChange={(e) => set("terminate", e.target.checked)} /> Stop at ground impact</label></div>}
      </fieldset>
      <fieldset><legend>Declared constraint (optional)</legend>
        <div className="sim-field"><label htmlFor="f-constrain"><input id="f-constrain" type="checkbox" checked={form.constrain} onChange={(e) => set("constrain", e.target.checked)} /> Require a constraint to hold, otherwise abstain</label></div>
        {form.constrain && <>
          <div className="sim-field"><label htmlFor="f-constraints-0-id">Constraint id</label><input id="f-constraints-0-id" value={form.constraintId} onChange={(e) => set("constraintId", e.target.value)} /></div>
          <div className="sim-field"><label htmlFor="f-constraints-0-observable">Observable</label>
            <select id="f-constraints-0-observable" value={form.observable} onChange={(e) => setForm((p) => ({ ...p, observable: e.target.value, limit: qty(p.limit.value, OBSERVABLE_UNIT[e.target.value] ?? "m") }))}>
              {OBSERVABLES.map((o) => <option key={o} value={o}>{o}</option>)}</select></div>
          <div className="sim-field"><label htmlFor="f-constraints-0-aggregate">Evaluated as</label>
            <select id="f-constraints-0-aggregate" value={form.aggregate} onChange={(e) => set("aggregate", e.target.value as Form["aggregate"])}>
              <option value="FINAL">Final value</option><option value="MAX">Maximum over the trace</option><option value="MIN">Minimum over the trace</option></select></div>
          <div className="sim-field"><label htmlFor="f-constraints-0-op">Rule</label>
            <select id="f-constraints-0-op" value={form.op} onChange={(e) => set("op", e.target.value as Form["op"])}><option value="LE">at most</option><option value="GE">at least</option></select></div>
          <QuantityField id="constraints-0-limit" label="Limit" value={form.limit} onChange={(v) => set("limit", v)} /></>}
      </fieldset>
      <fieldset><legend>Output</legend>
        <div className="sim-field"><label htmlFor="f-render-video"><input id="f-render-video" type="checkbox" checked={form.video} onChange={(e) => set("video", e.target.checked)} /> Also render an MP4 animation (needs host video tools)</label></div>
      </fieldset>
      <p><button type="submit" disabled={busy}>Run simulation</button></p>
    </form>
    <p role="status" aria-live="polite" aria-busy={busy} data-run-status>{busy ? "Running the solver on the host…" : view ? `Last result: ${view.outcome}.` : "No result yet."}</p>
    {Object.keys(fieldErrors).length > 0 && <div role="alert" data-field-errors><p>The scenario has fields that are not numbers:</p><ul>{Object.entries(fieldErrors).map(([id, message]) => <li key={id}><a href={`#${id}`}>{message}</a> ({id})</li>)}</ul></div>}
    {failure && <div role="alert" tabIndex={-1} ref={failureRef} className="sim-failure" data-failure-code={failure.code} data-failure-tone={failure.tone} data-failure-path={failure.path ?? ""}>
      <h3>{failure.tone === "invalid" ? "Scenario not valid" : failure.tone === "budget" ? "Over budget" : failure.tone === "denied" ? "Denied" : failure.tone === "notFound" ? "Not found" : failure.tone === "conflict" ? "Request conflict" : failure.tone === "unknown" ? "Outcome unknown" : "Unavailable"}</h3>
      <p><code>{failure.code}</code>: {failure.message}{failure.path ? <> Offending value: <code>{failure.path}</code>.</> : null} Nothing was solved or stored.</p></div>}
    {view && <Result port={simulation} view={view} />}
    <form onSubmit={(event) => void reopen(event)} aria-label="Reopen a stored simulation">
      <div className="sim-field"><label htmlFor="sim-reopen-id">Reopen a stored simulation by id</label>
        <input id="sim-reopen-id" value={reopenId} onChange={(e) => setReopenId(e.target.value)} autoComplete="off" /></div>
      <p><button type="submit" disabled={busy || !reopenId.trim()}>Reopen stored result</button></p>
    </form>
  </section>;
}
