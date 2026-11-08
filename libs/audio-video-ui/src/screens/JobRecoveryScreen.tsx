import React from "react";
import { MediaTaskScreen, type MediaTaskScreenProps } from "./MediaTaskScreen";
import { createMediaActionDispatchGuard } from "./MediaActionDispatchGuard";

export type CanonicalJobStatus = "ACCEPTED" | "RUNNING" | "OUTCOME_UNKNOWN" | "COMPLETED" | "FAILED" | "CANCELLED";

/** Structural subset of MediaCanonicalClient. Hosts pass the authenticated, scope-validating SDK instance. */
export interface CanonicalJobReadClient {
  getJob(jobId: string, signal?: AbortSignal): Promise<{
    readonly jobId: string;
    readonly status: CanonicalJobStatus;
    readonly version: number;
  }>;
}

type CanonicalJobReadState =
  | { readonly state: "NOT_ADMITTED" }
  | { readonly state: "READY" }
  | { readonly state: "LOADING" }
  | { readonly state: "DENIED" }
  | { readonly state: "UNKNOWN" }
  | { readonly state: "OBSERVED"; readonly status: CanonicalJobStatus; readonly version: number };

export interface JobRecoveryProjection {
  readonly jobId: string;
  readonly sourceArtifactVersion?: string;
  readonly attemptId?: string;
  readonly observedAt?: string;
  readonly connectionObservation?: "connected" | "detached" | "stale" | "unavailable";
  readonly finality?: string;
  readonly message?: string;
  readonly completedOutputs?: readonly { readonly id: string; readonly label: string }[];
}

export interface JobRecoveryScreenProps extends Omit<MediaTaskScreenProps, "children"> {
  readonly job: JobRecoveryProjection;
  /** Optional authenticated canonical client; absent means the read action is NOT_ADMITTED. */
  readonly canonicalJobReadClient?: CanonicalJobReadClient;
}

/** Candidate J-20 body. It preserves job identity and reports observed facts; safe actions come from the host. */
export function JobRecoveryScreen({ job, canonicalJobReadClient, ...flow }: JobRecoveryScreenProps): React.ReactElement {
  const [, refreshDispatchState] = React.useState(0);
  const dispatchGuard = React.useMemo(
    () => createMediaActionDispatchGuard(flow.actionPort, () => refreshDispatchState((version) => version + 1)),
    [flow.actionPort],
  );
  React.useEffect(() => {
    dispatchGuard.observeReconciliations(flow.data.actionReconciliations ?? []);
  }, [dispatchGuard, flow.data.actionReconciliations]);
  const guardedActions = flow.actions?.map((action) => dispatchGuard.isInFlight(action.id)
    ? { ...action, enabled: false, disabledReason: "This request has not been reconciled by the owner; check the same job before retrying." }
    : action);
  const initialReadState: CanonicalJobReadState = canonicalJobReadClient ? { state: "READY" } : { state: "NOT_ADMITTED" };
  const [readStateRecord, setReadStateRecord] = React.useState({ jobId: job.jobId, reader: canonicalJobReadClient, value: initialReadState });
  const activeRead = React.useRef<AbortController | undefined>(undefined);
  const readState = readStateRecord.jobId === job.jobId && readStateRecord.reader === canonicalJobReadClient
    ? readStateRecord.value
    : initialReadState;
  const setReadState = (value: CanonicalJobReadState): void => setReadStateRecord({ jobId: job.jobId, reader: canonicalJobReadClient, value });
  React.useEffect(() => {
    activeRead.current?.abort();
    activeRead.current = undefined;
    return () => {
      activeRead.current?.abort();
      activeRead.current = undefined;
    };
  }, [job.jobId, canonicalJobReadClient]);
  const readCanonicalStatus = (): void => {
    if (!canonicalJobReadClient || readState.state === "LOADING" || activeRead.current) return;
    const controller = new AbortController();
    activeRead.current = controller;
    setReadState({ state: "LOADING" });
    void canonicalJobReadClient.getJob(job.jobId, controller.signal).then((snapshot) => {
      if (controller.signal.aborted || activeRead.current !== controller) return;
      if (snapshot.jobId !== job.jobId || ![
        "ACCEPTED", "RUNNING", "OUTCOME_UNKNOWN", "COMPLETED", "FAILED", "CANCELLED",
      ].includes(snapshot.status) || !Number.isSafeInteger(snapshot.version) || snapshot.version < 1) {
        setReadState({ state: "UNKNOWN" });
        return;
      }
      setReadState({ state: "OBSERVED", status: snapshot.status, version: snapshot.version });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || activeRead.current !== controller) return;
      const statusCode = error && typeof error === "object" && "statusCode" in error
        ? (error as { readonly statusCode?: unknown }).statusCode
        : undefined;
      setReadState(statusCode === 401 || statusCode === 403 ? { state: "DENIED" } : { state: "UNKNOWN" });
    }).finally(() => {
      if (activeRead.current === controller) activeRead.current = undefined;
    });
  };
  const terminalStatuses = new Set<CanonicalJobStatus>(["COMPLETED", "FAILED", "CANCELLED"]);
  const readStateMessage = (() => {
    switch (readState.state) {
      case "NOT_ADMITTED": return "Canonical job status refresh is NOT_ADMITTED. No live status was requested.";
      case "READY": return "Canonical status has not been refreshed in this view.";
      case "LOADING": return "Loading canonical job status…";
      case "DENIED": return "Canonical job status read was denied. No status is disclosed.";
      case "UNKNOWN": return "Canonical job status is unknown. Reconcile the same job before taking another action.";
      case "OBSERVED":
        return terminalStatuses.has(readState.status)
          ? `Terminal status observed: ${readState.status} (version ${readState.version}).`
          : readState.status === "OUTCOME_UNKNOWN"
            ? "Canonical job reports OUTCOME_UNKNOWN. Reconcile the same job before retrying."
            : `Canonical job status observed: ${readState.status} (version ${readState.version}).`;
    }
  })();
  return <MediaTaskScreen {...flow} actions={guardedActions} actionPort={dispatchGuard.actionPort}>
    <section className="media-screen-body" aria-labelledby="job-recovery-title">
      <header>
        <h3 id="job-recovery-title">Job status and recovery</h3>
        <p>Check this same job identity before starting another request.</p>
      </header>
      <dl>
        <div><dt>Job ID</dt><dd><code>{job.jobId}</code></dd></div>
        {job.attemptId && <div><dt>Attempt</dt><dd><code>{job.attemptId}</code></dd></div>}
        {job.sourceArtifactVersion && <div><dt>Source artifact version</dt><dd><code>{job.sourceArtifactVersion}</code></dd></div>}
        {job.observedAt && <div><dt>Last observed</dt><dd>{job.observedAt}</dd></div>}
        {job.connectionObservation && <div><dt>Connection observation</dt><dd>{job.connectionObservation}</dd></div>}
        {job.finality && <div><dt>Finality</dt><dd>{job.finality}</dd></div>}
      </dl>
      <section aria-labelledby="job-canonical-read-title">
        <h4 id="job-canonical-read-title">Canonical status read</h4>
        <p role="status" aria-live="polite" aria-atomic="true" aria-busy={readState.state === "LOADING"} data-state={readState.state.toLowerCase()}>
          {readStateMessage}
        </p>
        {canonicalJobReadClient && <button type="button" onClick={readCanonicalStatus} disabled={readState.state === "LOADING"}>
          Refresh canonical status
        </button>}
      </section>
      {job.message && <p role="status">{job.message}</p>}
      {job.completedOutputs?.length ? <section className="media-screen-body" aria-labelledby="job-outputs-title">
        <h4 id="job-outputs-title">Available completed outputs</h4>
        <ul>
          {job.completedOutputs.map((output) => <li key={output.id}>{output.label} <code>({output.id})</code></li>)}
        </ul>
      </section> : null}
      <p>A detached view does not confirm cancellation. An unknown outcome remains unknown until the job owner reports a result.</p>
    </section>
  </MediaTaskScreen>;
}
