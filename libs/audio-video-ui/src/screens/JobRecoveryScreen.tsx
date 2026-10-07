import React from "react";
import { MediaTaskScreen, type MediaTaskScreenProps } from "./MediaTaskScreen";

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
}

/** Candidate J-20 body. It preserves job identity and reports observed facts; safe actions come from the host. */
export function JobRecoveryScreen({ job, ...flow }: JobRecoveryScreenProps): React.ReactElement {
  return <MediaTaskScreen {...flow}>
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
