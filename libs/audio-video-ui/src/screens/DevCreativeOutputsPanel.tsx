import React from "react";
import {
  DevCreativeHostError, OBSERVABLE_GROUP, SIMULATED_LABEL, SIM_COMMON_FIELDS, SIM_MODEL_FIELDS, SIM_UNITS, SPATIAL_RIG_TEMPLATE,
  buildAudioRepairRequest, buildSimulationRequest, buildSpatialGlbRequest, describeCreativeFailure, emptySimulationForm,
  exampleSimulationForm, parseCreativeView, parseSimulationDocument,
  type Built, type CreativeKind, type CreativeOutcome, type CreativeView, type DevCreativeHostResponse, type DevCreativeOutputsPort,
  type SimFieldSpec, type SimFieldState, type SimModelType, type SimObservable, type SimulationDocument, type SimulationForm,
} from "./devCreativeOutputs";

export interface DevCreativeOutputsPanelProps {
  readonly outputs: DevCreativeOutputsPort;
  readonly locked?: boolean;
  /** Injectable for deterministic tests; must return a fresh opaque id per call. */
  readonly newRequestId?: () => string;
}

type Lane = "audio" | "simulation" | "spatial" | "reopen";
type Attempt = { readonly fingerprint: string; readonly requestId: string };
type Shown = { readonly view: CreativeView; readonly via: "created" | "replayed" | "reopened" };
type LaneState = { readonly message: string; readonly outcome: CreativeOutcome | null };
type SimDoc = { readonly state: "none" | "unavailable" | "loaded" | "failed"; readonly doc?: SimulationDocument; readonly text?: string };

let counter = 0;
const defaultRequestId = (): string => {
  const random = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${(counter++).toString(36)}`;
  return `ui-${random}`;
};
const asHost = (error: unknown): DevCreativeHostError => error instanceof DevCreativeHostError ? error
  : new DevCreativeHostError("INVALID_RESPONSE", 200, error instanceof Error ? error.message : "Invalid response.");
const KIND_NAME: Readonly<Record<CreativeKind, string>> = {
  AUDIO_REPAIR_CANDIDATE: "audio repair candidate", SIMULATED_OUTPUT_NOT_MEASUREMENT: "simulated output (not a measurement)", SPATIAL_GLB_EXPORT: "spatial GLB export",
};
const IDLE: LaneState = { message: "Nothing requested.", outcome: null };
const toneHeading = (tone: CreativeOutcome["tone"]): string =>
  tone === "unknown" ? "Outcome unknown" : tone === "denied" ? "Denied" : tone === "unavailable" ? "Unavailable" : "Not registered";

function QuantityRow(props: {
  readonly id: string; readonly spec: Pick<SimFieldSpec, "label" | "measurement"> & { readonly group: keyof typeof SIM_UNITS };
  readonly state: SimFieldState; readonly disabled: boolean; readonly onChange: (next: SimFieldState) => void;
}): React.ReactElement {
  const { id, spec, state, disabled, onChange } = props;
  return <fieldset aria-labelledby={`${id}-legend`}>
    <legend id={`${id}-legend`}>{spec.label}</legend>
    <label htmlFor={`${id}-value`}>Value</label>
    <input id={`${id}-value`} type="text" inputMode="decimal" value={state.value} disabled={disabled} onChange={(event) => onChange({ ...state, value: event.currentTarget.value })} />
    {spec.measurement && <>
      <label htmlFor={`${id}-uncertainty`}>Standard uncertainty</label>
      <input id={`${id}-uncertainty`} type="text" inputMode="decimal" value={state.uncertainty} disabled={disabled} onChange={(event) => onChange({ ...state, uncertainty: event.currentTarget.value })} />
    </>}
    <label htmlFor={`${id}-unit`}>Unit</label>
    <select id={`${id}-unit`} value={state.unit} disabled={disabled} onChange={(event) => onChange({ ...state, unit: event.currentTarget.value })}>
      {SIM_UNITS[spec.group].map((unit) => <option key={unit} value={unit}>{unit}</option>)}
    </select>
  </fieldset>;
}

/** DEV_ONLY creative outputs. It never claims quality, measurement, approval, production rights or delivery. */
export function DevCreativeOutputsPanel({ outputs, locked = false, newRequestId = defaultRequestId }: DevCreativeOutputsPanelProps): React.ReactElement {
  const [audio, setAudio] = React.useState({ artifactId: "", artifactVersionId: "", threshold: "", maxRunFrames: "" });
  const [sim, setSim] = React.useState<SimulationForm>(() => emptySimulationForm());
  const [rigText, setRigText] = React.useState("");
  const [reopenId, setReopenId] = React.useState("");
  const [shown, setShown] = React.useState<Shown | null>(null);
  const [simDoc, setSimDoc] = React.useState<SimDoc>({ state: "none" });
  const [lanes, setLanes] = React.useState<Record<Lane, LaneState>>({ audio: IDLE, simulation: IDLE, spatial: IDLE, reopen: IDLE });
  const [formErrors, setFormErrors] = React.useState<Record<"audio" | "simulation" | "spatial", readonly string[]>>({ audio: [], simulation: [], spatial: [] });
  const [pending, setPending] = React.useState<Lane | null>(null);
  const attempts = React.useRef<Record<"audio" | "simulation" | "spatial", Attempt | null>>({ audio: null, simulation: null, spatial: null });
  const busy = pending !== null;
  const disabled = locked || busy;

  const setLane = (lane: Lane, state: LaneState): void => setLanes((current) => ({ ...current, [lane]: state }));
  const attemptFor = (lane: "audio" | "simulation" | "spatial", fingerprint: string): Attempt => {
    const current = attempts.current[lane];
    if (current && current.fingerprint === fingerprint) return current;
    const created = { fingerprint, requestId: newRequestId() };
    attempts.current[lane] = created;
    return created;
  };

  const loadSimulationDocument = async (view: CreativeView): Promise<void> => {
    if (view.kind !== "SIMULATED_OUTPUT_NOT_MEASUREMENT") { setSimDoc({ state: "none" }); return; }
    if (!outputs.readSimulationDocument) { setSimDoc({ state: "unavailable" }); return; }
    try {
      const response = await outputs.readSimulationDocument(view.outputId);
      if (response.status !== 200) throw new Error(`Unexpected status ${response.status}.`);
      setSimDoc({ state: "loaded", doc: parseSimulationDocument(response.body) });
    } catch (error) {
      setSimDoc({ state: "failed", text: error instanceof Error ? error.message : "The simulation document could not be read." });
    }
  };

  const accept = async (lane: Lane, response: DevCreativeHostResponse, via: "post" | "get", expected: Parameters<typeof parseCreativeView>[1], expectedOutputId?: string): Promise<void> => {
    const okStatus = via === "post" ? response.status === 200 || response.status === 201 : response.status === 200;
    if (!okStatus) throw new DevCreativeHostError("INVALID_RESPONSE", response.status, "Unexpected success status.");
    const view = parseCreativeView(response.body, expected);
    if (expectedOutputId !== undefined && view.outputId !== expectedOutputId) throw new DevCreativeHostError("INVALID_RESPONSE", response.status, "Reopened output does not match the requested id.");
    if (via === "post" && (response.status === 200) !== view.replayed) throw new DevCreativeHostError("INVALID_RESPONSE", response.status, "Status and replay flag disagree.");
    const how: Shown["via"] = via === "get" ? "reopened" : view.replayed ? "replayed" : "created";
    setShown({ view, via: how });
    setSimDoc({ state: "none" });
    setLane(lane, { outcome: null, message: how === "replayed"
      ? `Replayed (HTTP 200): the same request identity returned existing output ${view.outputId}; no second output was created.`
      : how === "created" ? `Created (HTTP 201): registered ${view.artifact.contentType} output ${view.outputId} as a ${KIND_NAME[view.kind]}.`
        : `Reopened output ${view.outputId} (${KIND_NAME[view.kind]}) from the host; its registered artifact identity is shown below.` });
    await loadSimulationDocument(view);
  };

  const fail = (lane: Lane, error: unknown): CreativeOutcome => {
    const outcome = describeCreativeFailure(asHost(error));
    setLane(lane, { outcome, message: `${outcome.code}: ${outcome.text}` });
    return outcome;
  };

  async function submit(lane: "audio" | "simulation" | "spatial", build: (requestId: string) => Built<unknown>,
    call: (request: never) => Promise<DevCreativeHostResponse>, expected: Parameters<typeof parseCreativeView>[1]): Promise<void> {
    if (disabled) return;
    const probe = build("");
    if (!probe.ok) { setFormErrors((current) => ({ ...current, [lane]: probe.errors })); setLane(lane, { outcome: null, message: "Fix the listed fields; nothing was sent." }); return; }
    setFormErrors((current) => ({ ...current, [lane]: [] }));
    const attempt = attemptFor(lane, JSON.stringify({ ...(probe.request as object), requestId: "" }));
    const built = build(attempt.requestId);
    if (!built.ok) return;
    setPending(lane);
    setLane(lane, { outcome: null, message: "Submitting DEV_ONLY request…" });
    try {
      const response = await call(built.request as never);
      await accept(lane, response, "post", { ...expected, ...(lane === "audio" ? { audioSource: (built.request as { source: { artifactId: string; artifactVersionId: string } }).source } : {}) });
    } catch (error) {
      const outcome = fail(lane, error);
      if (outcome.discardRequest) attempts.current[lane] = null;
    } finally { setPending(null); }
  }

  const submitAudio = (): Promise<void> => submit("audio", (id) => buildAudioRepairRequest(audio, id), (request) => outputs.repairAudio(request), { kind: "AUDIO_REPAIR_CANDIDATE" });
  const submitSimulation = (): Promise<void> => submit("simulation", (id) => buildSimulationRequest(sim, id), (request) => outputs.simulate(request), { kind: "SIMULATED_OUTPUT_NOT_MEASUREMENT" });
  const submitSpatial = (): Promise<void> => submit("spatial", (id) => buildSpatialGlbRequest(rigText, id), (request) => outputs.exportSpatialGlb(request), { kind: "SPATIAL_GLB_EXPORT" });

  const reopen = async (event?: React.FormEvent): Promise<void> => {
    event?.preventDefault();
    const id = reopenId.trim();
    if (disabled) return;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) { setLane("reopen", { outcome: null, message: "Enter a valid output ID; nothing was sent." }); return; }
    setPending("reopen"); setLane("reopen", { outcome: null, message: `Reopening output ${id}…` });
    try {
      const response = await outputs.getOutput(id);
      await accept("reopen", response, "get", {}, id);
    } catch (error) { fail("reopen", error); } finally { setPending(null); }
  };

  const setSimField = (key: string, next: SimFieldState): void => setSim((current) => ({ ...current, fields: { ...current.fields, [key]: next } }));
  const retryable = (lane: "audio" | "simulation" | "spatial"): boolean => !!lanes[lane].outcome?.retrySameRequest && attempts.current[lane] !== null;
  const retryButton = (lane: "audio" | "simulation" | "spatial", run: () => Promise<void>): React.ReactNode => retryable(lane)
    ? <button type="button" onClick={() => void run()} disabled={disabled}>Retry with the same request identity</button> : null;
  const laneStatus = (lane: Lane, id: string): React.ReactNode => <>
    <p id={id} role="status" aria-live="polite" aria-atomic="true" aria-busy={pending === lane}
      data-state={lanes[lane].outcome ? lanes[lane].outcome!.tone : "idle"}>{lanes[lane].message}</p>
    {lanes[lane].outcome && <div role="alert" data-outcome={lanes[lane].outcome!.tone}>
      <strong>{toneHeading(lanes[lane].outcome!.tone)} · <code>{lanes[lane].outcome!.code}</code></strong>
      {lanes[lane].outcome!.findings.length > 0 && <ul aria-label="Validator findings">{lanes[lane].outcome!.findings.map((finding, index) =>
        <li key={`${finding.reason}-${index}`}><code>{finding.reason}</code>{finding.subject ? ` · ${finding.subject}` : ""}{finding.detail ? ` · ${finding.detail}` : ""}</li>)}</ul>}
    </div>}
  </>;
  const errorList = (lane: "audio" | "simulation" | "spatial", id: string): React.ReactNode => formErrors[lane].length > 0
    ? <ul id={id} role="alert" aria-label="Form problems">{formErrors[lane].map((message) => <li key={message}>{message}</li>)}</ul> : null;

  const simSpecs: readonly SimFieldSpec[] = [...SIM_MODEL_FIELDS[sim.model], ...SIM_COMMON_FIELDS];
  const view = shown?.view ?? null;

  return <section id="dev-creative-outputs" aria-labelledby="creative-title" data-outputs="DEV_ONLY">
    <h2 id="creative-title">Creative outputs · DEV_ONLY</h2>
    <p>Local development audio repair, scenario simulation and spatial GLB export for the authenticated owner. Outputs are engine results under explicit inputs. They carry no quality, measurement, approval, production-rights or delivery claim.</p>

    <section aria-labelledby="audio-title">
      <h3 id="audio-title">Audio repair</h3>
      <p>Repairs one exact owner artifact version (16-bit PCM WAV) into a NEW artifact. The source version is never modified. The profile is explicit: nothing is defaulted.</p>
      <form id="audio-form" onSubmit={(event) => { event.preventDefault(); void submitAudio(); }}>
        <label htmlFor="audio-artifact-id">Source artifact ID</label>
        <input id="audio-artifact-id" type="text" autoComplete="off" value={audio.artifactId} disabled={disabled} onChange={(event) => setAudio({ ...audio, artifactId: event.currentTarget.value })} />
        <label htmlFor="audio-version-id">Exact source artifact version</label>
        <input id="audio-version-id" type="text" autoComplete="off" value={audio.artifactVersionId} disabled={disabled} onChange={(event) => setAudio({ ...audio, artifactVersionId: event.currentTarget.value })} />
        <label htmlFor="audio-threshold">Clipping threshold (0.5 to 1, fraction of the source peak)</label>
        <input id="audio-threshold" type="text" inputMode="decimal" value={audio.threshold} disabled={disabled} onChange={(event) => setAudio({ ...audio, threshold: event.currentTarget.value })} />
        <label htmlFor="audio-run">Maximum clipped run (frames)</label>
        <input id="audio-run" type="text" inputMode="numeric" value={audio.maxRunFrames} disabled={disabled} onChange={(event) => setAudio({ ...audio, maxRunFrames: event.currentTarget.value })} />
        {errorList("audio", "audio-errors")}
        <button type="submit" disabled={disabled}>Repair exact source version</button>
        {retryButton("audio", submitAudio)}
      </form>
      {laneStatus("audio", "audio-status")}
    </section>

    <section aria-labelledby="sim-title">
      <h3 id="sim-title">Simulation</h3>
      <aside role="note" aria-label="Simulated output label" data-label={SIMULATED_LABEL}>
        <strong>{SIMULATED_LABEL}</strong> · Output is deterministic model output from the scenario below. It is not a measurement and is not evidence about any physical system.
      </aside>
      <form id="simulation-form" onSubmit={(event) => { event.preventDefault(); void submitSimulation(); }}>
        <label htmlFor="sim-model">Model</label>
        <select id="sim-model" value={sim.model} disabled={disabled} onChange={(event) => setSim({ ...sim, model: event.currentTarget.value as SimModelType })}>
          <option value="CONSTANT_FORCE">CONSTANT_FORCE</option>
          <option value="HARMONIC_SPRING">HARMONIC_SPRING</option>
        </select>
        {simSpecs.map((spec) => <QuantityRow key={spec.key} id={`sim-${spec.key}`} spec={spec} state={sim.fields[spec.key]!} disabled={disabled} onChange={(next) => setSimField(spec.key, next)} />)}
        <label htmlFor="sim-steps">Maximum accepted steps</label>
        <input id="sim-steps" type="text" inputMode="numeric" value={sim.maxAcceptedSteps} disabled={disabled} onChange={(event) => setSim({ ...sim, maxAcceptedSteps: event.currentTarget.value })} />
        <label htmlFor="sim-iterations">Maximum iterations</label>
        <input id="sim-iterations" type="text" inputMode="numeric" value={sim.maxIterations} disabled={disabled} onChange={(event) => setSim({ ...sim, maxIterations: event.currentTarget.value })} />
        <fieldset aria-labelledby="sim-invariant-legend">
          <legend id="sim-invariant-legend">Declared invariant (optional)</legend>
          <p>Without a declared invariant the validator abstains and no output is registered.</p>
          <label htmlFor="sim-invariant-id">Invariant ID</label>
          <input id="sim-invariant-id" type="text" value={sim.invariantId} disabled={disabled} onChange={(event) => setSim({ ...sim, invariantId: event.currentTarget.value })} />
          <label htmlFor="sim-invariant-observable">Observable</label>
          <select id="sim-invariant-observable" value={sim.invariantObservable} disabled={disabled} onChange={(event) => {
            const observable = event.currentTarget.value as SimObservable;
            const unit = SIM_UNITS[OBSERVABLE_GROUP[observable]][0]!;
            setSim({ ...sim, invariantObservable: observable, invariantExpected: { ...sim.invariantExpected, unit }, invariantTolerance: { ...sim.invariantTolerance, unit } });
          }}>
            {(["POSITION", "VELOCITY", "TOTAL_ENERGY"] as const).map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <QuantityRow id="sim-invariant-expected" spec={{ label: "Expected terminal value", measurement: false, group: OBSERVABLE_GROUP[sim.invariantObservable] }}
            state={sim.invariantExpected} disabled={disabled} onChange={(next) => setSim({ ...sim, invariantExpected: next })} />
          <QuantityRow id="sim-invariant-tolerance" spec={{ label: "Absolute tolerance", measurement: false, group: OBSERVABLE_GROUP[sim.invariantObservable] }}
            state={sim.invariantTolerance} disabled={disabled} onChange={(next) => setSim({ ...sim, invariantTolerance: next })} />
        </fieldset>
        {errorList("simulation", "simulation-errors")}
        <button type="button" onClick={() => setSim(exampleSimulationForm())} disabled={disabled}>Load worked example (6 N on 2 kg for 2 s)</button>
        <button type="submit" disabled={disabled}>Run simulation</button>
        {retryButton("simulation", submitSimulation)}
      </form>
      {laneStatus("simulation", "simulation-status")}
    </section>

    <section aria-labelledby="spatial-title">
      <h3 id="spatial-title">Spatial GLB export</h3>
      <p>Paste an explicit rig as JSON: right-handed +X/+Y/+Z frame, metre and unit-quaternion references, bones, exact-rational keyframes, and the exact owner artifact versions it derives from. The shape is checked here; the engine decides what it supports. Keyframe times are stored as float32 seconds in the GLB.</p>
      <form id="spatial-form" onSubmit={(event) => { event.preventDefault(); void submitSpatial(); }}>
        <label htmlFor="spatial-rig">Rig JSON</label>
        <textarea id="spatial-rig" rows={12} spellCheck={false} value={rigText} disabled={disabled} onChange={(event) => setRigText(event.currentTarget.value)} />
        {errorList("spatial", "spatial-errors")}
        <button type="button" onClick={() => setRigText(SPATIAL_RIG_TEMPLATE)} disabled={disabled}>Insert rig template (placeholder source ids)</button>
        <button type="submit" disabled={disabled}>Export GLB</button>
        {retryButton("spatial", submitSpatial)}
      </form>
      {laneStatus("spatial", "spatial-status")}
    </section>

    <section aria-labelledby="reopen-title">
      <h3 id="reopen-title">Reopen an output</h3>
      <form id="reopen-form" onSubmit={(event) => void reopen(event)}>
        <label htmlFor="reopen-id">Output ID</label>
        <input id="reopen-id" type="text" autoComplete="off" value={reopenId} disabled={disabled} onChange={(event) => setReopenId(event.currentTarget.value)} />
        <button type="submit" disabled={disabled}>Reopen output from the host</button>
      </form>
      {laneStatus("reopen", "reopen-status")}
    </section>

    {view && <article id="creative-result" aria-labelledby="creative-result-title" data-output-id={view.outputId} data-kind={view.kind}>
      <h3 id="creative-result-title">Registered output · {shown!.via} · {KIND_NAME[view.kind]}</h3>
      {view.kind === "SIMULATED_OUTPUT_NOT_MEASUREMENT" && <p role="note" data-label={SIMULATED_LABEL}><strong>{SIMULATED_LABEL}</strong> · simulated model output; not a measurement.</p>}
      <dl>
        <div><dt>Output ID</dt><dd><code>{view.outputId}</code></dd></div>
        <div><dt>Artifact version</dt><dd><code>{view.artifact.artifactVersionId}</code></dd></div>
        <div><dt>SHA-256</dt><dd><code>{view.artifact.sha256}</code></dd></div>
        <div><dt>Content type and size</dt><dd>{view.artifact.contentType}{view.artifact.sizeBytes === null ? "" : ` · ${view.artifact.sizeBytes} bytes`}</dd></div>
        <div><dt>Engine</dt><dd>{view.engine ?? "not reported"}</dd></div>
        <div><dt>Request identity</dt><dd><code>{view.requestId ?? "not reported"}</code></dd></div>
        <div><dt>Scope</dt><dd>DEV_ONLY</dd></div>
      </dl>
      {view.audio && <>
        <h4>Lineage · exact source version</h4>
        <dl aria-label="Audio repair lineage">
          <div><dt>Source artifact</dt><dd><code>{view.audio.source.artifactId}</code></dd></div>
          <div><dt>Source version</dt><dd><code>{view.audio.source.artifactVersionId}</code></dd></div>
          {view.audio.source.sha256 && <div><dt>Source SHA-256</dt><dd><code>{view.audio.source.sha256}</code></dd></div>}
          <div><dt>Profile</dt><dd>threshold {view.audio.profile.threshold ?? "?"} · maxRunFrames {view.audio.profile.maxRunFrames ?? "?"}</dd></div>
          {view.audio.comparisonEngine && <div><dt>Comparison engine</dt><dd>{view.audio.comparisonEngine}</dd></div>}
        </dl>
        <h4>Engine sample statistics</h4>
        <p>Reported by the comparison engine for this source and candidate pair. They describe samples only and are not a quality assessment.</p>
        <dl aria-label="Engine sample statistics">{view.audio.metrics.map((metric) =>
          <div key={metric.name}><dt>{metric.name}</dt><dd>{metric.value}</dd></div>)}</dl>
      </>}
      {view.simulation && <>
        <h4>Simulation lineage</h4>
        <dl aria-label="Simulation lineage">
          <div><dt>Evidence class</dt><dd><code>{view.simulation.evidenceClass}</code></dd></div>
          <div><dt>Validation disposition</dt><dd>{view.simulation.validationDisposition}</dd></div>
          {view.simulation.referenceAuthority && <div><dt>Reference authority</dt><dd>{view.simulation.referenceAuthority}</dd></div>}
          {view.simulation.scenarioSha256 && <div><dt>Scenario SHA-256</dt><dd><code>{view.simulation.scenarioSha256}</code></dd></div>}
        </dl>
        <ul aria-label="Simulation input references">{view.simulation.inputReferences.map((ref) => <li key={ref.role}>{ref.role} · <code>{ref.identity}</code></li>)}</ul>
        <dl aria-label="Solver statistics">{view.simulation.solverStats.map((stat) => <div key={stat.name}><dt>{stat.name}</dt><dd>{stat.value}</dd></div>)}</dl>
        {simDoc.state === "loaded" && simDoc.doc && <>
          <h4>Observation series · {SIMULATED_LABEL}</h4>
          <p>{simDoc.doc.disclaimer}</p>
          <table aria-label="Simulated observation series">
            <thead><tr>{(["time", "position", "velocity", "acceleration", "totalEnergy"] as const).map((column) =>
              <th key={column} scope="col">{column} ({simDoc.doc!.units[column]})</th>)}</tr></thead>
            <tbody>{simDoc.doc.rows.map((row) => <tr key={row.time}><td>{row.time}</td><td>{row.position}</td><td>{row.velocity}</td><td>{row.acceleration}</td><td>{row.totalEnergy}</td></tr>)}</tbody>
          </table>
        </>}
        {simDoc.state === "unavailable" && <p role="note">The unit-labelled observation series is stored in the registered artifact. This host exposes no DEV_ONLY content route to this page, so it is not displayed here.</p>}
        {simDoc.state === "failed" && <p role="alert">The observation series could not be read: {simDoc.text}</p>}
      </>}
      {view.spatial && <>
        <h4>Spatial lineage</h4>
        <dl aria-label="Spatial GLB lineage">
          {view.spatial.rigId && <div><dt>Rig</dt><dd><code>{view.spatial.rigId}</code></dd></div>}
          {view.spatial.sourceProjectRevisionRef && <div><dt>Source project revision</dt><dd><code>{view.spatial.sourceProjectRevisionRef}</code></dd></div>}
          <div><dt>Time encoding</dt><dd>{view.spatial.timeEncoding ?? "not reported"}</dd></div>
          <div><dt>Loss disposition</dt><dd>{view.spatial.lossDisposition ?? "not reported"}</dd></div>
          <div><dt>float32LossFields</dt><dd>{view.spatial.float32LossFields.join(", ") || "none reported"}</dd></div>
        </dl>
        <ul aria-label="Spatial source versions">{view.spatial.sources.map((source) => <li key={`${source.artifactId}@${source.artifactVersionId}`}><code>{source.artifactId}@{source.artifactVersionId}</code></li>)}</ul>
        <dl aria-label="Spatial coordinate frame">{view.spatial.coordinateFrame.map((entry) => <div key={entry.name}><dt>{entry.name}</dt><dd>{entry.value}</dd></div>)}</dl>
        <aside role="note" aria-label="Rights decision" data-production-grant="false">
          <strong>DEV_ONLY rights decision · productionGrant=false</strong> · authority <code>{view.spatial.rights.authority}</code>{view.spatial.rights.outcome ? ` · outcome ${view.spatial.rights.outcome}` : ""}.
          This is an owner-scope visibility check, not a licence or production grant.
        </aside>
      </>}
      {view.note && <p>{view.note}</p>}
    </article>}
  </section>;
}
